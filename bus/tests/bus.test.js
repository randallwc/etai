const assert = require("node:assert/strict");
const http = require("node:http");
const { test, before, after } = require("node:test");
const { createBusServer, FALLBACK } = require("../index.js");

let bus, calendar, messaging, base;
const calRequests = [];
const sends = [];

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function jsonServer(handler) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(JSON.parse(Buffer.concat(chunks) || "{}"), res));
  });
}

async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(fn(), "timed out waiting");
}

const inbound = (over = {}) => ({
  channel: "imessage",
  from: "+15551234567",
  body: "need a sprinkler repair Thursday",
  externalId: `ext-${Math.random()}`,
  receivedAt: new Date().toISOString(),
  threadKey: "+15551234567",
  ...over,
});

before(async () => {
  calendar = jsonServer((body, res) => {
    calRequests.push(body);
    const ok = body.message !== "boom";
    res.writeHead(ok ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(
      ok
        ? { response: "Booked Thursday 2pm.", toolCalls: [], spear: null, status: "success" }
        : { error: "upstream exploded" }
    ));
  });
  messaging = jsonServer((body, res) => {
    sends.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ externalId: "m-1" }));
  });
  await Promise.all([
    new Promise((r) => calendar.listen(0, r)),
    new Promise((r) => messaging.listen(0, r)),
  ]);

  bus = createBusServer({
    AMBIGUOUS_BASE_URL: `http://127.0.0.1:${calendar.address().port}`,
    AMBIGUOUS_API_KEY: "ak_test",
    MESSAGING_URL: `http://127.0.0.1:${messaging.address().port}`,
  }).server;
  await new Promise((r) => bus.listen(0, r));
  base = `http://127.0.0.1:${bus.address().port}`;
});

after(() => {
  bus.close();
  calendar.close();
  messaging.close();
});

test("inbound prose is forwarded to the calendar ai and its reply texted back", async () => {
  const res = await post(`${base}/webhooks/inbound`, inbound());
  assert.equal(res.status, 202);
  assert.equal((await res.json()).accepted, true);

  await waitFor(() => calRequests.length === 1);
  assert.equal(calRequests[0].message, "need a sprinkler repair Thursday");
  assert.equal(calRequests[0].context.audience, "agent");

  await waitFor(() => sends.length === 1);
  assert.equal(sends[0].to, "+15551234567");
  assert.equal(sends[0].body, "Booked Thursday 2pm.");
  assert.equal(sends[0].threadKey, "+15551234567");
});

test("duplicate externalId is accepted but not forwarded", async () => {
  const msg = inbound({ externalId: "dup-1" });
  const before = calRequests.length;
  await post(`${base}/webhooks/inbound`, msg);
  const again = await post(`${base}/webhooks/inbound`, msg);
  assert.equal((await again.json()).accepted, false);
  await waitFor(() => calRequests.length === before + 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calRequests.length, before + 1);
});

test("malformed inbound is 400 and never forwarded", async () => {
  const before = calRequests.length;
  assert.equal((await post(`${base}/webhooks/inbound`, { from: "+1" })).status, 400);
  assert.equal((await post(`${base}/webhooks/inbound`, "not json")).status, 400);
  assert.equal(calRequests.length, before);
});

test("calendar failure replies with the fallback text", async () => {
  await post(`${base}/webhooks/inbound`, inbound({ body: "boom" }));
  await waitFor(() => sends.at(-1)?.body === FALLBACK);
});

test("offline mode: no api key still 202s and does not call the calendar", async () => {
  const offline = createBusServer({}).server;
  await new Promise((r) => offline.listen(0, r));
  const offlineBase = `http://127.0.0.1:${offline.address().port}`;
  const before = calRequests.length;
  const res = await post(`${offlineBase}/webhooks/inbound`, inbound());
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calRequests.length, before);
  offline.close();
});

test("healthz reports wiring", async () => {
  const res = await fetch(`${base}/healthz`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.calendar, true);
  assert.match(body.messaging, /^http:\/\/127\.0\.0\.1/);
});
