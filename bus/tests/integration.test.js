const assert = require("node:assert/strict");
const http = require("node:http");
const { test, before, after } = require("node:test");
const { createBusServer } = require("../index.js");
const { createMessagingServer } = require("../../messaging/index.js");

let messaging, bus, ambiguous, bluebubbles, msgBase;
const ambiHits = [];
const phoneSends = [];

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
      } else if (req.url.startsWith("/api/calendars/events")) {
        payload = { data: [] };
      } else {
        payload = { data: [] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
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
  const ambiBase = await listen(ambiguous);
  const bbBase = await listen(bluebubbles);

  messaging = createMessagingServer({
    BLUEBUBBLES_URL: bbBase,
    BLUEBUBBLES_PASSWORD: "pw",
  }).server;
  msgBase = await listen(messaging);

  bus = createBusServer({
    AMBIGUOUS_BASE_URL: ambiBase,
    AMBIGUOUS_API_KEY: "ak_test",
    MESSAGING_URL: msgBase,
  }).server;
  const busBase = await listen(bus);

  await post(`${msgBase}/subscriptions`, { url: `${busBase}/webhooks/inbound` });
});

after(() => {
  messaging.close();
  bus.close();
  ambiguous.close();
  bluebubbles.close();
});

test("a text travels messaging -> bus -> calendar ai -> back out as a reply", async () => {
  const res = await post(`${msgBase}/simulate/inbound`, {
    from: "+15557654321",
    body: "what's my day",
  });
  assert.equal(res.status, 202);

  await waitFor(() => ambiHits.some((h) => h.path === "/api/assistant/chat"));
  const chat = ambiHits.find((h) => h.path === "/api/assistant/chat");
  assert.match(chat.body.message, /what's my day/);

  await waitFor(() => ambiHits.some((h) => h.path.startsWith("/api/calendars/events")));

  await waitFor(() => phoneSends.length === 1);
  const send = phoneSends[0];
  assert.match(send.path, /^\/api\/v1\/message\/text\?password=pw$/);
  assert.equal(send.body.chatGuid, "any;-;+15557654321");
  assert.equal(send.body.message, "Nothing on the calendar today.");
});

test("duplicate delivery through messaging reaches the loop once", async () => {
  const before = ambiHits.filter((h) => h.path === "/api/assistant/chat").length;
  const event = {
    type: "new-message",
    data: {
      guid: "BB-DUP-1",
      text: "running 20 late",
      isFromMe: false,
      handle: { address: "+15557654321" },
      dateCreated: Date.now(),
    },
  };
  await post(`${msgBase}/webhooks/bluebubbles`, event);
  await post(`${msgBase}/webhooks/bluebubbles`, event);
  await waitFor(() => phoneSends.length >= 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    ambiHits.filter((h) => h.path === "/api/assistant/chat").length,
    before + 1,
  );
});
