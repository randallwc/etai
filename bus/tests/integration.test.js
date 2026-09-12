const assert = require("node:assert/strict");
const http = require("node:http");
const { test, before, after } = require("node:test");
const { createBusServer } = require("../index.js");
const { createMessagingServer } = require("../../messaging/index.js");

const CONTRACTOR = "+15551112222";
const CLIENT = "+15557654321";

let messaging, bus, ambiguous, bluebubbles, msgBase, ambiBase, busCal;
const ambiHits = [];
const phoneSends = [];
let stallChat = false;

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function listen(server) {
  await new Promise((r) => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(fn(), "timed out waiting");
}

before(async () => {
  ambiguous = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(chunks.length ? Buffer.concat(chunks) : "{}");
      ambiHits.push({ method: req.method, path: req.url, body });
      let payload;
      if (req.url === "/api/assistant/chat") {
        payload = { response: '{"intent":"day_summary"}', toolCalls: [], spear: null, status: "success" };
      } else {
        payload = { data: [] };
      }
      const finish = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/api/assistant/chat" && stallChat) setTimeout(finish, 3000);
      else finish();
    });
  });
  bluebubbles = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      phoneSends.push({ path: req.url, body: JSON.parse(chunks.length ? Buffer.concat(chunks) : "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { guid: "bb-out-1" } }));
    });
  });
  ambiBase = await listen(ambiguous);
  const bbBase = await listen(bluebubbles);

  messaging = createMessagingServer({
    BLUEBUBBLES_URL: bbBase,
    BLUEBUBBLES_PASSWORD: "pw",
  }).server;
  msgBase = await listen(messaging);

  ({ server: bus, calendar: busCal } = createBusServer({
    AMBIGUOUS_BASE_URL: ambiBase,
    AMBIGUOUS_API_KEY: "ak_test",
    MESSAGING_URL: msgBase,
    CONTRACT_PHONE: CONTRACTOR,
    AI_CLASSIFY_TIMEOUT_MS: "200",
  }));
  const busBase = await listen(bus);
  await busCal.sync();

  await post(`${msgBase}/subscriptions`, { url: `${busBase}/webhooks/inbound` });
});

after(() => {
  messaging.close();
  bus.close();
  ambiguous.close();
  bluebubbles.close();
});

test("a text travels messaging -> bus -> assistant -> back out as a reply", async () => {
  const res = await post(`${msgBase}/simulate/inbound`, {
    from: CONTRACTOR,
    body: "blocked on a part, update me on the plan",
  });
  assert.equal(res.status, 202);

  await waitFor(() => ambiHits.some((h) => h.path === "/api/assistant/chat"));
  const chat = ambiHits.find((h) => h.path === "/api/assistant/chat");
  assert.match(chat.body.message, /blocked on a part/);

  await waitFor(() => ambiHits.some((h) => h.path.startsWith("/api/calendars/events")));

  await waitFor(() => phoneSends.length === 1);
  const send = phoneSends[0];
  assert.match(send.path, /^\/api\/v1\/message\/text\?password=pw$/);
  assert.equal(send.body.chatGuid, `any;-;${CONTRACTOR}`);
  assert.equal(send.body.message, "etAI update: Nothing on the calendar today.");
});

test("keyword intents answer without an assistant call", async () => {
  const chatBefore = ambiHits.filter((h) => h.path === "/api/assistant/chat").length;
  const sendsBefore = phoneSends.length;
  await post(`${msgBase}/simulate/inbound`, { from: CONTRACTOR, body: "what's my day" });
  await waitFor(() => phoneSends.length === sendsBefore + 1);
  assert.equal(phoneSends.at(-1).body.message, "Nothing on the calendar today.");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    ambiHits.filter((h) => h.path === "/api/assistant/chat").length,
    chatBefore,
  );
});

test("a stalled assistant still produces a reply via keyword fallback", async () => {
  stallChat = true;
  const sendsBefore = phoneSends.length;
  try {
    await post(`${msgBase}/simulate/inbound`, { from: CLIENT, body: "cancel my visit" });
    await waitFor(() => phoneSends.length === sendsBefore + 1);
  } finally {
    stallChat = false;
  }
  assert.match(phoneSends.at(-1).body.message, /don't see a booking to cancel/i);
});

test("a client saying they are late does not move the calendar", async () => {
  const writesBefore = ambiHits.filter((h) => h.method === "PATCH" || h.method === "POST").length;
  const sendsBefore = phoneSends.length;
  await post(`${msgBase}/simulate/inbound`, { from: CLIENT, body: "running 15 late, sorry" });
  await waitFor(() =>
    phoneSends.some((s) => s.body.chatGuid === `any;-;${CLIENT}` && /let them know/i.test(s.body.message)),
  );
  assert.equal(
    ambiHits.filter((h) => h.method === "PATCH" || h.method === "POST").length,
    writesBefore,
  );
  assert.ok(phoneSends.length - sendsBefore <= 2);
});

test("fake phone loop: gateway text in -> reply out through ambimail", async () => {
  const mailMessaging = createMessagingServer({
    AMBIG_API: "ak_test",
    AMBIGUOUS_BASE_URL: ambiBase,
    MAIL_POLL_SECONDS: "0",
  }).server;
  const mailBase = await listen(mailMessaging);
  const bus2 = createBusServer({
    AMBIGUOUS_BASE_URL: ambiBase,
    AMBIGUOUS_API_KEY: "ak_test",
    MESSAGING_URL: mailBase,
    CONTRACT_PHONE: CONTRACTOR,
  }).server;
  const bus2Base = await listen(bus2);
  await post(`${mailBase}/subscriptions`, { url: `${bus2Base}/webhooks/inbound` });
  try {
    const res = await post(`${mailBase}/webhooks/ambimail`, {
      id: "evt_loop1",
      type: "email.received",
      resourceId: "mail-loop-1",
      data: {
        senderEmail: "15557654321@vtext.com",
        subject: "(no subject)",
        bodyFull: "what's my day",
      },
    });
    assert.equal((await res.json()).accepted, true);
    await waitFor(() => ambiHits.some((h) => h.path === "/api/mail/send"));
    const send = ambiHits.find((h) => h.path === "/api/mail/send");
    assert.deepEqual(send.body.to, ["5557654321@vtext.com"]);
    assert.match(send.body.body_markdown, /Nothing booked/);
  } finally {
    bus2.close();
    mailMessaging.close();
  }
});

test("duplicate delivery through messaging reaches the loop once", async () => {
  const sendsBefore = phoneSends.length;
  const event = {
    type: "new-message",
    data: {
      guid: "BB-DUP-1",
      text: "running 20 late",
      isFromMe: false,
      handle: { address: CONTRACTOR },
      dateCreated: Date.now(),
    },
  };
  await post(`${msgBase}/webhooks/bluebubbles`, event);
  await post(`${msgBase}/webhooks/bluebubbles`, event);
  await waitFor(() => phoneSends.length === sendsBefore + 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(phoneSends.at(-1).body.message, /don't see an active job/i);
});

test("a messaging restart wipes subscribers until the bus re-subscribes", async () => {
  const sinkBodies = [];
  const sink = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      sinkBodies.push({ path: req.url, body: JSON.parse(chunks.length ? Buffer.concat(chunks) : "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const sinkBase = await listen(sink);

  let msg = createMessagingServer({}).server;
  const restartBase = await listen(msg);
  const port = msg.address().port;
  const { subscribeOnce } = createBusServer({
    MESSAGING_URL: restartBase,
    PUBLIC_URL: sinkBase,
  });
  const healthz = async () => (await fetch(`${restartBase}/healthz`)).json();

  try {
    assert.equal(await subscribeOnce(), true);
    assert.equal((await healthz()).subscribers, 1);

    const closing = new Promise((r) => msg.close(r));
    msg.closeIdleConnections();
    await closing;
    msg = createMessagingServer({}).server;
    await new Promise((r) => msg.listen(port, r));
    let health;
    for (let i = 0; i < 100 && !health; i++) {
      health = await healthz().catch(() => null);
      if (!health) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(health?.subscribers, 0);

    assert.equal(await subscribeOnce(), true);
    assert.equal((await healthz()).subscribers, 1);

    const res = await post(`${restartBase}/simulate/inbound`, { from: CLIENT, body: "test" });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).accepted, true);
    await waitFor(() => sinkBodies.some((s) => s.path === "/webhooks/inbound"));
    const inbound = sinkBodies.find((s) => s.path === "/webhooks/inbound");
    assert.equal(inbound.body.from, CLIENT);
    assert.equal(inbound.body.body, "test");
  } finally {
    msg.close();
    sink.close();
  }
});
