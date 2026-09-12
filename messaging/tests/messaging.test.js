const assert = require("node:assert/strict");
const http = require("node:http");
const { test, before, after } = require("node:test");
const { createMessagingServer } = require("../index.js");

let messaging, upstream, base, upstreamBase;
const received = [];

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  messaging = createMessagingServer({}).server;
  await new Promise((r) => messaging.listen(0, r));
  base = `http://127.0.0.1:${messaging.address().port}`;

  await post(`${base}/subscriptions`, { url: `${upstreamBase}/webhooks/inbound` });
});

after(() => {
  messaging.close();
  upstream.close();
});

test("transport selection prefers bluebubbles, then ambimail, then sim", () => {
  const { createTransport } = require("../transports.js");
  assert.equal(
    createTransport({ BLUEBUBBLES_URL: "https://x", BLUEBUBBLES_PASSWORD: "p" }).name,
    "bluebubbles"
  );
  assert.equal(createTransport({ AMBIG_API: "ak_x" }).name, "ambimail");
  assert.equal(createTransport({}).name, "sim");
});

test("send returns an externalId and rejects a bad phone", async () => {
  const ok = await post(`${base}/send`, { to: "+15551234567", body: "ETA 10:20" });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).externalId, /^sim-/);

  const bad = await post(`${base}/send`, { to: "notaphone", body: "hi" });
  assert.equal(bad.status, 400);
});

test("simulate inbound fans out a normalized message to subscribers", async () => {
  const res = await post(`${base}/simulate/inbound`, {
    from: "+15551234567",
    body: "what's my day",
  });
  assert.equal(res.status, 202);
  const msg = received.at(-1);
  assert.equal(msg.from, "+15551234567");
  assert.equal(msg.channel, "imessage");
  assert.equal(msg.body, "what's my day");
  assert.ok(msg.externalId);
});

const bluebubblesEvent = {
  type: "new-message",
  data: {
    guid: "BB-GUID-123",
    text: "can you come Thursday",
    isFromMe: false,
    handle: { address: "+15557654321" },
    chats: [{ guid: "any;-;+15557654321" }],
    dateCreated: 1757700000000,
  },
};

test("bluebubbles new-message normalizes and fans out", async () => {
  const res = await post(`${base}/webhooks/bluebubbles`, bluebubblesEvent);
  assert.equal(res.status, 202);
  assert.equal((await res.json()).accepted, true);
  const msg = received.at(-1);
  assert.equal(msg.channel, "imessage");
  assert.equal(msg.from, "+15557654321");
  assert.equal(msg.externalId, "BB-GUID-123");
});

test("bluebubbles dedups, ignores own sends and non-message events", async () => {
  const before = received.length;
  await post(`${base}/webhooks/bluebubbles`, bluebubblesEvent);
  await post(`${base}/webhooks/bluebubbles`, {
    ...bluebubblesEvent,
    data: { ...bluebubblesEvent.data, guid: "BB-GUID-OWN", isFromMe: true },
  });
  await post(`${base}/webhooks/bluebubbles`, { type: "typing-indicator", data: {} });
  assert.equal(received.length, before);
});

test("ambimail email.received normalizes gateway sender and fans out", async () => {
  const res = await post(`${base}/webhooks/ambimail`, {
    type: "email.received",
    data: {
      id: "mail-9",
      from: { email: "5550100100@vtext.com" },
      body_text: "yes 2 works",
      created_at: "2026-09-12T20:00:00Z",
    },
  });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).accepted, true);
  const msg = received.at(-1);
  assert.equal(msg.channel, "sms");
  assert.equal(msg.from, "+15550100100");
  assert.equal(msg.body, "yes 2 works");
});

test("ambimail rejects non-gateway senders and non-mail events", async () => {
  const before = received.length;
  await post(`${base}/webhooks/ambimail`, {
    type: "email.received",
    data: { id: "m2", from: { email: "someone@gmail.com" }, body_text: "hi" },
  });
  await post(`${base}/webhooks/ambimail`, { type: "webhook.test", data: { test: true } });
  assert.equal(received.length, before);
});
