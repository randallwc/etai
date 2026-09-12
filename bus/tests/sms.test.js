const assert = require("node:assert/strict");
const http = require("node:http");
const { test, before, after } = require("node:test");
const { createBusServer } = require("../index.js");
const { createMessagingServer } = require("../../messaging/index.js");
const { createAi } = require("../ai.js");

const CLIENT = "+14253625633";
const CLIENT_GATEWAY = "4253625633@vtext.com";
const CONTRACTOR_GATEWAY = "5550001111@vtext.com";

let ambiguous, smsMessaging, smsBus, simMessaging, simBus, mailPoller, smsCal;
let smsMsgBase, simMsgBase;
const mailOut = [];
const patchedMail = [];
const eventWrites = [];
const remoteEvents = [];
const inbox = [];

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

const { fallbackClassify } = createAi({});

function gatewayMail(id, body, domain = "vtext.com") {
  return post(`${smsMsgBase}/webhooks/ambimail`, {
    type: "email.received",
    data: {
      id,
      from: { email: `4253625633@${domain}` },
      body_text: body,
      created_at: "2026-09-12T20:00:00Z",
    },
  });
}

before(async () => {
  ambiguous = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(chunks.length ? Buffer.concat(chunks) : "{}");
      const path = new URL(req.url, "http://x").pathname;
      let payload = {};
      if (path === "/api/assistant/chat") {
        const m = body.message.match(/Text: ("[\s\S]*")$/);
        payload = { response: JSON.stringify(fallbackClassify(m ? JSON.parse(m[1]) : "")) };
      } else if (path === "/api/users") {
        payload = { data: [{ id: "u-1", type: "human" }] };
      } else if (path === "/api/calendars" && req.method === "GET") {
        payload = { data: [{ id: "cal-1", is_default: true }] };
      } else if (path === "/api/calendars/availability") {
        payload = { availability: { "u-1": [] } };
      } else if (path === "/api/calendars/events" && req.method === "GET") {
        payload = { data: remoteEvents };
      } else if (path === "/api/calendars/cal-1/events" && req.method === "POST") {
        eventWrites.push({ method: "POST", body });
        remoteEvents.push({ id: `ev-${eventWrites.length}`, ...body });
        payload = { event: remoteEvents.at(-1) };
      } else if (path.startsWith("/api/calendars/events/")) {
        eventWrites.push({ method: req.method, path });
        const rid = path.split("/").pop();
        const i = remoteEvents.findIndex((e) => e.id === rid);
        if (req.method === "DELETE" && i >= 0) remoteEvents.splice(i, 1);
        else if (req.method === "PATCH" && i >= 0) Object.assign(remoteEvents[i], body);
        payload = { event: remoteEvents[i] ?? { id: rid } };
      } else if (path === "/api/crm/contacts" && req.method === "POST") {
        payload = { contact: { id: "crm-1", ...body } };
      } else if (path === "/api/crm/contacts") {
        payload = { data: [] };
      } else if (path === "/api/tasks") {
        payload = { task: { id: "t-1", title: body.title } };
      } else if (path === "/api/mail/send") {
        mailOut.push(body);
        payload = { id: `mail-${mailOut.length}` };
      } else if (path === "/api/mail/inbox") {
        payload = { data: inbox, total: inbox.length, has_more: false };
      } else if (req.method === "PATCH" && path.startsWith("/api/mail/")) {
        patchedMail.push(path);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  const ambiBase = await listen(ambiguous);

  ({ server: smsMessaging, mailPoller } = createMessagingServer({
    AMBIG_API: "ak_test",
    AMBIGUOUS_BASE_URL: ambiBase,
    MAIL_POLL_SECONDS: "3600",
  }));
  smsMsgBase = await listen(smsMessaging);

  ({ server: smsBus, calendar: smsCal } = createBusServer({
    AMBIGUOUS_BASE_URL: ambiBase,
    AMBIGUOUS_API_KEY: "ak_test",
    MESSAGING_URL: smsMsgBase,
    CONTRACT_PHONE: "+15550001111",
    CONTRACTOR_TZ: "UTC",
  }));
  const smsBusBase = await listen(smsBus);
  await post(`${smsMsgBase}/subscriptions`, { url: `${smsBusBase}/webhooks/inbound` });

  ({ server: simMessaging } = createMessagingServer({}));
  simMsgBase = await listen(simMessaging);
  ({ server: simBus } = createBusServer({
    AMBIGUOUS_BASE_URL: ambiBase,
    MESSAGING_URL: simMsgBase,
    CONTRACT_PHONE: "+15550001111",
    CONTRACTOR_TZ: "UTC",
  }));
  const simBusBase = await listen(simBus);
  await post(`${simMsgBase}/subscriptions`, { url: `${simBusBase}/webhooks/inbound` });
});

after(() => {
  mailPoller.stop();
  smsMessaging.close();
  smsBus.close();
  simMessaging.close();
  simBus.close();
  ambiguous.close();
});

test("gateway mail in produces a reply back out to the gateway", async () => {
  const res = await gatewayMail("sms-1", "what is my day");
  assert.equal(res.status, 202);
  await waitFor(() => mailOut.length === 1);
  assert.deepEqual(mailOut[0].to, [CLIENT_GATEWAY]);
  assert.equal(mailOut[0].body_markdown, "Nothing booked for you right now - want me to set something up?");
});

test("a booking is proposed and confirmed entirely over sms", async () => {
  await gatewayMail("sms-2", "can you come fix my sink");
  await waitFor(() => mailOut.some((m) => /9:00 AM/.test(m.body_markdown)));
  const offer = mailOut.find((m) => /9:00 AM/.test(m.body_markdown));
  assert.deepEqual(offer.to, [CLIENT_GATEWAY]);
  assert.match(offer.body_markdown, /which works/i);

  await gatewayMail("sms-3", "1");
  await waitFor(() => mailOut.some((m) => /Locked in/.test(m.body_markdown)));
  await waitFor(() =>
    mailOut.some((m) => m.to[0] === CONTRACTOR_GATEWAY && /New booking/.test(m.body_markdown)),
  );
  await smsCal.sync();
  const created = eventWrites.find((w) => w.method === "POST");
  assert.match(created.body.title, /fix my sink/);
});

test("mailpoller carries a gateway reply into the loop", async () => {
  inbox.push({
    id: "mail-cancel-1",
    from: { email: "4253625633@vzwpix.com" },
    read: false,
    body_text: "cancel my visit",
    sent_at: "2026-09-12T21:00:00Z",
  });
  await mailPoller.pollOnce();
  await waitFor(() =>
    mailOut.some((m) => m.to[0] === CLIENT_GATEWAY && /^Canceled/.test(m.body_markdown)),
  );
  await waitFor(() =>
    mailOut.some((m) => m.to[0] === CONTRACTOR_GATEWAY && /Client canceled/.test(m.body_markdown)),
  );
  assert.ok(patchedMail.includes("/api/mail/mail-cancel-1"));
  await smsCal.sync();
  assert.ok(eventWrites.some((w) => w.method === "DELETE"));
});

test("a reply seen by both webhook and poller collapses to one turn", async () => {
  const before = mailOut.length;
  await gatewayMail("mail-both-1", "what is my day");
  await waitFor(() => mailOut.length === before + 1);
  inbox.push({
    id: "mail-both-1",
    from: { email: CLIENT_GATEWAY },
    read: false,
    body_text: "what is my day",
  });
  await mailPoller.pollOnce();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mailOut.length, before + 1);
});

test("sim transport runs the whole loop with no providers", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => lines.push(String(msg));
  try {
    await post(`${simMsgBase}/simulate/inbound`, {
      from: CLIENT,
      body: "what is my day",
      channel: "sms",
    });
    await waitFor(() => lines.some((l) => l.includes(`[sim] -> ${CLIENT}`)));
  } finally {
    console.log = orig;
  }
  const out = lines.find((l) => l.includes(`[sim] -> ${CLIENT}`));
  assert.match(out, /Nothing booked for you right now/);
});
