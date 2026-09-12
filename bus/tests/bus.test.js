const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { createBusServer } = require("../index.js");

let server, base;
const sent = [];
const handled = [];

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
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
  body: "hi",
  externalId: `ext-${Math.random()}`,
  receivedAt: new Date().toISOString(),
  threadKey: "+15551234567",
  ...over,
});

before(async () => {
  ({ server } = createBusServer(
    { CONTRACT_PHONE: "+15550001111" },
    {
      notify: async ({ to, body }) => sent.push({ to, body }),
      loop: { handle: async (m) => handled.push(m) },
      calendar: { stub: true },
      ambi: { enabled: false, createTask: async () => null },
      ai: { classify: async () => ({ intent: "other" }) },
      tts: { synthesize: async () => Buffer.from("fake-mp3") },
    },
  ));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("inbound is validated, deduped, and handed to the loop", async () => {
  const msg = inbound();
  const res = await post(`${base}/webhooks/inbound`, msg);
  assert.equal(res.status, 202);
  assert.equal((await res.json()).accepted, true);
  await waitFor(() => handled.length === 1);
  assert.equal(handled[0].externalId, msg.externalId);

  const again = await post(`${base}/webhooks/inbound`, msg);
  assert.equal((await again.json()).duplicate, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(handled.length, 1);
});

test("malformed inbound is rejected", async () => {
  assert.equal((await post(`${base}/webhooks/inbound`, { from: "+1" })).status, 400);
  assert.equal((await post(`${base}/webhooks/inbound`, "not json")).status, 400);
  assert.equal(
    (await post(`${base}/webhooks/inbound`, inbound({ from: "notaphone" }))).status,
    400,
  );
});

test("calendar notification texts the contractor once", async () => {
  const note = {
    id: `cal-${Math.random()}`,
    kind: "reminder",
    eventId: "e1",
    title: "Sprinkler repair",
    startAt: "2026-09-13T22:00:00Z",
    triggerAt: "2026-09-13T21:50:00Z",
    detectedAt: new Date().toISOString(),
  };
  const before = sent.length;
  const res = await post(`${base}/webhooks/calendar`, note);
  assert.equal(res.status, 202);
  await waitFor(() => sent.length === before + 1);
  assert.equal(sent.at(-1).to, "+15550001111");
  assert.match(sent.at(-1).body, /Reminder: Sprinkler repair at \d/);

  const again = await post(`${base}/webhooks/calendar`, note);
  assert.equal((await again.json()).accepted, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, before + 1);
});

test("malformed calendar notification is 400", async () => {
  assert.equal((await post(`${base}/webhooks/calendar`, { kind: "reminder" })).status, 400);
  assert.equal((await post(`${base}/webhooks/calendar`, "not json")).status, 400);
});

test("tts endpoint returns audio and cors preflight is answered", async () => {
  const res = await post(`${base}/tts`, { text: "hello" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /audio\/mpeg/);
  assert.equal(await res.text(), "fake-mp3");

  const opt = await fetch(`${base}/tts`, { method: "OPTIONS" });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");

  assert.equal((await post(`${base}/tts`, {})).status, 400);
});

test("healthz reports wiring", async () => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.stub, true);
  assert.equal(body.ambiguous, false);
  assert.equal(body.messaging, false);
});
