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

test("ambimail sends the text as body_markdown so the body survives", async () => {
  const { createTransport } = require("../transports.js");
  let sent;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  };
  try {
    await createTransport({ AMBIG_API: "ak_x" }).send({ to: "+15551234567", body: "hi there" });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(sent.body.to[0], "5551234567@vtext.com");
  assert.equal(sent.body.body_markdown, "hi there");
});

test("ambimail GATEWAY_MAP blasts a mapped number across carriers", async () => {
  const { createTransport } = require("../transports.js");
  const sends = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sends.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  };
  try {
    const t = createTransport({
      AMBIG_API: "ak_x",
      GATEWAY_MAP: "+15550100102:tmomail.net+txt.att.net+vtext.com",
    });
    await t.send({ to: "+15550100102", body: "hi" });
    assert.deepEqual(sends.map((s) => s.to[0]), [
      "5550100102@tmomail.net",
      "5550100102@txt.att.net",
      "5550100102@vtext.com",
    ]);
    sends.length = 0;
    await t.send({ to: "+15551234567", body: "hi" });
    assert.deepEqual(sends.map((s) => s.to[0]), ["5551234567@vtext.com"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("ambimail send succeeds when some gateways reject", async () => {
  const { createTransport } = require("../transports.js");
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const to = JSON.parse(opts.body).to[0];
    if (to.endsWith("@msg.fi.google.com")) {
      return new Response(JSON.stringify({ error: "suppressed" }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  };
  try {
    const t = createTransport({
      AMBIG_API: "ak_x",
      GATEWAY_MAP: "5550100102:msg.fi.google.com+vtext.com",
    });
    const r = await t.send({ to: "+15550100102", body: "hi" });
    assert.equal(r.externalId, "m1");
  } finally {
    globalThis.fetch = orig;
  }
});

test("POST bodies over the cap get 413, malformed JSON gets 400", async () => {
  const big = await post(`${base}/send`, { to: "+15551234567", body: "x".repeat(1 << 20) });
  assert.equal(big.status, 413);
  const bad = await fetch(`${base}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(bad.status, 400);
});

test("a hanging subscriber fails the fanout fast instead of stalling the ack", async () => {
  const hung = http.createServer(() => {});
  await new Promise((r) => hung.listen(0, "127.0.0.1", r));
  const srv = createMessagingServer({
    FETCH_TIMEOUT_MS: "80",
    UPSTREAM_URL: `http://127.0.0.1:${hung.address().port}`,
  }).server;
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const loneBase = `http://127.0.0.1:${srv.address().port}`;
  try {
    const t0 = Date.now();
    const res = await post(`${loneBase}/simulate/inbound`, { from: "+15557654321", body: "hi" });
    assert.equal(res.status, 503);
    assert.ok(Date.now() - t0 < 2000, "fanout did not honor the timeout");
  } finally {
    srv.close();
    hung.closeAllConnections();
    hung.close();
  }
});

test("one hung subscriber does not block delivery to a healthy one", async () => {
  const hung = http.createServer(() => {});
  await new Promise((r) => hung.listen(0, "127.0.0.1", r));
  const srv = createMessagingServer({
    FETCH_TIMEOUT_MS: "80",
    UPSTREAM_URL: `http://127.0.0.1:${hung.address().port}`,
  }).server;
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const loneBase = `http://127.0.0.1:${srv.address().port}`;
  try {
    const before = received.length;
    await post(`${loneBase}/subscriptions`, { url: `${upstreamBase}/webhooks/inbound` });
    const res = await post(`${loneBase}/simulate/inbound`, { from: "+15557654321", body: "hi" });
    assert.equal(res.status, 202);
    assert.equal(received.length, before + 1);
  } finally {
    srv.close();
    hung.closeAllConnections();
    hung.close();
  }
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

test("ambimail normalizes the live payload shape: senderEmail + bodyFull", async () => {
  const res = await post(`${base}/webhooks/ambimail`, {
    id: "evt_live1",
    type: "email.received",
    resourceId: "mail-live-1",
    data: {
      senderEmail: "5550100100@vzwpix.com",
      subject: "(no subject)",
      bodyPreview: "see you at 3",
      bodyFull: "see you at 3",
    },
  });
  assert.equal((await res.json()).accepted, true);
  const msg = received.at(-1);
  assert.equal(msg.from, "+15550100100");
  assert.equal(msg.body, "see you at 3");
});

test("ambimail drops (no content) MMS replies -- the poller reads the attachment", async () => {
  const before = received.length;
  const res = await post(`${base}/webhooks/ambimail`, {
    type: "email.received",
    data: { senderEmail: "5550100100@vzwpix.com", bodyFull: "(no content)", bodyPreview: "(no content)" },
  });
  assert.equal((await res.json()).accepted, false);
  assert.equal(received.length, before);
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

test("redelivery of the same mail id is deduped, not fanned out again", async () => {
  const event = {
    type: "email.received",
    data: { id: "mail-dup", from: { email: "5550100100@vtext.com" }, body_text: "hi" },
  };
  await post(`${base}/webhooks/ambimail`, event);
  const before = received.length;
  const res = await post(`${base}/webhooks/ambimail`, event);
  assert.equal((await res.json()).accepted, true);
  assert.equal(received.length, before);
});

test("healthz and /messages report live state", async () => {
  const hz = await (await fetch(`${base}/healthz`)).json();
  assert.equal(hz.ok, true);
  assert.equal(hz.transport, "sim");
  assert.ok(hz.subscribers >= 1);
  const { messages } = await (await fetch(`${base}/messages`)).json();
  assert.ok(messages.some((m) => m.externalId === "ambmail-mail-9"));
});

test("subscriptions rejects a non-http url", async () => {
  const res = await post(`${base}/subscriptions`, { url: "ftp://x" });
  assert.equal(res.status, 400);
});

test("inbound with no subscriber is refused, then delivered when one appears", async () => {
  const lone = createMessagingServer({}).server;
  await new Promise((r) => lone.listen(0, r));
  const loneBase = `http://127.0.0.1:${lone.address().port}`;
  try {
    const event = {
      type: "new-message",
      data: {
        guid: "BB-HELD-1",
        text: "hello?",
        isFromMe: false,
        handle: { address: "+15557654321" },
        dateCreated: 1757700000000,
      },
    };
    const r1 = await post(`${loneBase}/webhooks/bluebubbles`, event);
    assert.equal((await r1.json()).accepted, false);
    await post(`${loneBase}/subscriptions`, { url: `${upstreamBase}/webhooks/inbound` });
    const r2 = await post(`${loneBase}/webhooks/bluebubbles`, event);
    assert.equal((await r2.json()).accepted, true);
    assert.ok(received.some((m) => m.externalId === "BB-HELD-1"));
  } finally {
    lone.close();
  }
});

test("simulate inbound reports 503 when no subscriber accepts", async () => {
  const lone = createMessagingServer({}).server;
  await new Promise((r) => lone.listen(0, r));
  const loneBase = `http://127.0.0.1:${lone.address().port}`;
  try {
    const res = await post(`${loneBase}/simulate/inbound`, { from: "+15557654321", body: "hi" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).accepted, false);
  } finally {
    lone.close();
  }
});

test("queued inbound reaches a late subscriber exactly once via retryUndelivered", async () => {
  const app = createMessagingServer({ FANOUT_RETRY_MS: 60000, FANOUT_RETRY_MAX: 5 });
  const lone = app.server;
  await new Promise((r) => lone.listen(0, r));
  const loneBase = `http://127.0.0.1:${lone.address().port}`;
  const sinkReceived = [];
  const sink = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      sinkReceived.push(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => sink.listen(0, r));
  const sinkBase = `http://127.0.0.1:${sink.address().port}`;
  try {
    await post(`${loneBase}/subscriptions`, { url: "http://127.0.0.1:1/webhooks/inbound" });
    const res = await post(`${loneBase}/simulate/inbound`, { from: "+15551234567", body: "hi" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).accepted, false);
    const hz1 = await (await fetch(`${loneBase}/healthz`)).json();
    assert.ok(hz1.queued >= 1);
    await post(`${loneBase}/subscriptions`, { url: `${sinkBase}/webhooks/inbound` });
    await app.retryUndelivered();
    assert.equal(sinkReceived.length, 1);
    assert.equal(sinkReceived[0].from, "+15551234567");
    assert.equal(sinkReceived[0].body, "hi");
    assert.equal(sinkReceived[0].channel, "imessage");
    assert.ok(sinkReceived[0].externalId);
    const hz2 = await (await fetch(`${loneBase}/healthz`)).json();
    assert.equal(hz2.queued, 0);
    await app.retryUndelivered();
    assert.equal(sinkReceived.length, 1);
  } finally {
    lone.close();
    sink.close();
  }
});

test("ambimail send retries once on a 5xx or network blip", async () => {
  const { createTransport } = require("../transports.js");
  let hits = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    hits += 1;
    if (hits === 1) throw new Error("socket hangup");
    return new Response(JSON.stringify({ id: "m-retry" }), { status: 200 });
  };
  try {
    const r = await createTransport({ AMBIG_API: "ak_x" }).send({ to: "+15551234567", body: "hi" });
    assert.equal(r.externalId, "m-retry");
    assert.equal(hits, 2);
  } finally {
    globalThis.fetch = orig;
  }
});
