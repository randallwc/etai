const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createService } = require("../index.js");
const { createStore } = require("../state.js");
const { stubCalendar } = require("../calendar.js");

const CONTRACTOR = "+15550001111";
const CLIENT = "+15557654321";

function fakeAi() {
  return {
    classify: async (body) => {
      const s = body.toLowerCase();
      if (/day|schedule|route/.test(s)) return { intent: "day_summary" };
      return { intent: "book", dayRef: "tomorrow", location: "22 main st" };
    },
  };
}

async function serve(overrides = {}) {
  const sent = [];
  const svc = createService(
    { CONTRACT_PHONE: CONTRACTOR, WORKING_BEAT_MS: "10" },
    {
      transport: {
        name: "fake",
        send: async (m) => (sent.push(m), { externalId: `x${sent.length}` }),
      },
      ai: fakeAi(),
      store: createStore(null),
      calendar: stubCalendar("UTC"),
      ambi: { enabled: false },
      tts: null,
      ...overrides,
    },
  );
  const port = await new Promise((r) => svc.server.listen(0, () => r(svc.server.address().port)));
  const post = (path, body) =>
    fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = (path) => fetch(`http://localhost:${port}${path}`);
  async function until(match, ms = 5000) {
    const start = Date.now();
    while (!sent.some(match) && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
  }
  return { svc, sent, post, get, until };
}

test("a booking text gets an offer reply", async () => {
  const { svc, sent, post, until } = await serve();
  try {
    const res = await post("/simulate/inbound", { from: CLIENT, body: "need sprinklers fixed tomorrow at 22 main st" });
    assert.equal(res.status, 202);
    await until((m) => m.to === CLIENT && /which works|\d+:\d{2} [AP]M/i.test(m.body));
    assert.ok(sent.some((m) => m.to === CLIENT && /which works|\d+:\d{2} [AP]M/i.test(m.body)), JSON.stringify(sent));
  } finally {
    svc.server.close();
  }
});

test("the same externalId is handled once", async () => {
  const { svc, sent, post, until } = await serve();
  try {
    const msg = {
      channel: "sms",
      from: CLIENT,
      body: "book tomorrow at 22 main st",
      externalId: "dup-1",
      receivedAt: new Date().toISOString(),
      threadKey: CLIENT,
    };
    assert.equal((await post("/webhooks/inbound", msg)).status, 202);
    const dup = await post("/webhooks/inbound", msg);
    assert.equal((await dup.json()).duplicate, true);
    await until((m) => m.to === CLIENT && !/On it/i.test(m.body));
    const replies = sent.filter((m) => m.to === CLIENT && !/On it/i.test(m.body));
    assert.equal(replies.length, 1, JSON.stringify(sent));
  } finally {
    svc.server.close();
  }
});

test("/send validates and prefixes outbound texts", async () => {
  const { svc, sent, post } = await serve();
  try {
    assert.equal((await post("/send", { to: "nope", body: "hi" })).status, 400);
    assert.equal((await post("/send", { to: CLIENT })).status, 400);
    const ok = await post("/send", { to: CLIENT, body: "hello" });
    assert.equal(ok.status, 200);
    assert.equal(sent[0].body, "etAI update: hello");
  } finally {
    svc.server.close();
  }
});

test("a voice turn gets a spoken reply", async () => {
  const { svc, post } = await serve();
  try {
    const res = await post("/voice/turn", { from: CLIENT, body: "what's my day" });
    const { reply } = await res.json();
    assert.equal(typeof reply, "string");
    assert.ok(reply.length > 0);
  } finally {
    svc.server.close();
  }
});

test("a calendar notification texts the contractor", async () => {
  const { svc, sent, post, until } = await serve();
  try {
    const res = await post("/webhooks/calendar", {
      id: "ev1",
      kind: "created",
      summary: "Lawn mow",
      startAt: "2030-01-01T17:00:00Z",
    });
    assert.equal(res.status, 202);
    await until((m) => m.to === CONTRACTOR);
    assert.equal(sent[0].to, CONTRACTOR);
    assert.match(sent[0].body, /new on calendar|reminder/i);
  } finally {
    svc.server.close();
  }
});

test("healthz reports wiring", async () => {
  const { svc, get } = await serve();
  try {
    const res = await get("/healthz");
    const health = await res.json();
    assert.equal(health.ok, true);
    assert.equal(health.transport, "fake");
  } finally {
    svc.server.close();
  }
});
