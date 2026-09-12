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

test("healthz reports sim transport", async () => {
  const res = await fetch(`${base}/healthz`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.transport, "sim");
  assert.equal(body.subscribers, 1);
});

test("send returns an externalId via the sim transport", async () => {
  const res = await post(`${base}/send`, { to: "+15551234567", body: "ETA 10:20" });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.match(body.externalId, /^sim-/);
});

test("send rejects a bad phone number", async () => {
  const res = await post(`${base}/send`, { to: "notaphone", body: "hi" });
  assert.equal(res.status, 400);
});

test("simulate inbound fans out a normalized message to subscribers", async () => {
  const before = received.length;
  const res = await post(`${base}/simulate/inbound`, {
    from: "+15551234567",
    body: "what's my day",
  });
  assert.equal(res.status, 202);
  const msg = received.at(-1);
  assert.equal(received.length, before + 1);
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

test("bluebubbles new-message webhook normalizes and fans out", async () => {
  const before = received.length;
  const res = await post(`${base}/webhooks/bluebubbles`, bluebubblesEvent);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, true);
  const msg = received.at(-1);
  assert.equal(received.length, before + 1);
  assert.equal(msg.channel, "imessage");
  assert.equal(msg.from, "+15557654321");
  assert.equal(msg.externalId, "BB-GUID-123");
});

test("bluebubbles webhook dedups on the provider guid", async () => {
  const before = received.length;
  await post(`${base}/webhooks/bluebubbles`, bluebubblesEvent);
  assert.equal(received.length, before);
});

test("bluebubbles ignores own sends and non-message events", async () => {
  const before = received.length;
  await post(`${base}/webhooks/bluebubbles`, {
    ...bluebubblesEvent,
    data: { ...bluebubblesEvent.data, guid: "BB-GUID-OWN", isFromMe: true },
  });
  await post(`${base}/webhooks/bluebubbles`, { type: "typing-indicator", data: {} });
  assert.equal(received.length, before);
});

test("messages endpoint exposes the recent inbound log", async () => {
  const res = await fetch(`${base}/messages`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.messages.length >= 2);
});
