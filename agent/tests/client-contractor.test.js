const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAgentServer } = require("../index.js");
const { stubCalendar } = require("../calendar.js");
const { createAi } = require("../ai.js");
const { createStore } = require("../state.js");
const { startReminders } = require("../reminders.js");

const CONTRACTOR = "+15550001111";
const CLIENT = "+15557654321";

function fakeIntent(body) {
  const s = body.toLowerCase();
  if (/what.*day|schedule|route/.test(s)) return { intent: "day_summary" };
  const late = s.match(/running\s+(\d+)?\s*late/);
  if (late) return { intent: "running_late", delayMinutes: +(late[1] ?? 15) };
  if (/move|resched/.test(s)) return { intent: "reschedule", dayRef: "friday" };
  if (/cancel/.test(s)) return { intent: "cancel" };
  if (/need|book|come|fix/.test(s)) {
    return { intent: "book", dayRef: /thursday/.test(s) ? "thursday" : "tomorrow", description: body };
  }
  return { intent: "other" };
}

async function serve(extraEnv = {}) {
  const sent = [];
  const calendar = stubCalendar();
  const { server, store } = createAgentServer(
    { CONTRACT_PHONE: CONTRACTOR, CONTRACTOR_TZ: "UTC", ...extraEnv },
    {
      ai: { classify: async (b) => fakeIntent(b) },
      calendar,
      notify: async ({ to, body }) => {
        sent.push({ to, body });
        return { externalId: `n-${sent.length}` };
      },
    }
  );
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const inbound = (externalId, body, from = CLIENT) =>
    fetch(`${base}/webhooks/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "imessage", from, body, externalId,
        receivedAt: new Date().toISOString(), threadKey: from,
      }),
    });
  const until = async (n) => {
    for (let i = 0; i < 60 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(sent.length >= n, `expected ${n} sends, got ${sent.length}`);
  };
  return { server, sent, store, calendar, base, inbound, until };
}

test("client booking offers multiple slots and picking one books it, contractor told", async () => {
  const { server, sent, calendar, inbound, until } = await serve();
  try {
    await inbound("c1", "need sprinklers fixed tomorrow");
    await until(1);
    const offer = sent[0];
    assert.equal(offer.to, CLIENT);
    assert.match(offer.body, /1\).*2\)/);
    assert.match(offer.body, /reply with a number/i);

    await inbound("c2", "second");
    await until(3);
    assert.match(sent[1].body, /locked in/i);
    assert.equal(sent[2].to, CONTRACTOR);
    assert.match(sent[2].body, /new booking/i);

    const day = new Date(Date.now() + 86400000);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const events = await calendar.listDay({ date });
    assert.equal(events.length, 1);
    assert.equal(events[0].start, new Date(`${date}T10:30:00`).toISOString());
  } finally {
    server.close();
  }
});

test("contractor running late shifts the job and texts the client a new ETA", async () => {
  const { server, sent, inbound, until } = await serve();
  try {
    await inbound("l1", "book a job tomorrow");
    await inbound("l2", "1");
    await until(3);
    await inbound("l3", "running 20 late", CONTRACTOR);
    await until(5);
    assert.equal(sent[3].to, CLIENT);
    assert.match(sent[3].body, /20 min late/i);
    assert.equal(sent[4].to, CONTRACTOR);
    assert.match(sent[4].body, /shifted/i);
  } finally {
    server.close();
  }
});

test("client cancel frees the slot and notifies the contractor", async () => {
  const { server, sent, inbound, until } = await serve();
  try {
    await inbound("x1", "book tomorrow");
    await inbound("x2", "1");
    await until(3);
    await inbound("x3", "cancel my appointment");
    await until(5);
    assert.equal(sent[3].to, CLIENT);
    assert.match(sent[3].body, /canceled/i);
    assert.equal(sent[4].to, CONTRACTOR);
    assert.match(sent[4].body, /canceled.*slot is free/i);
  } finally {
    server.close();
  }
});

test("reschedule proposes slots and moves the existing event", async () => {
  const { server, sent, inbound, until } = await serve();
  try {
    await inbound("r1", "book tomorrow");
    await inbound("r2", "1");
    await until(3);
    await inbound("r3", "need to move it to friday");
    await until(4);
    assert.match(sent[3].body, /reply with a number/i);
    await inbound("r4", "1");
    await until(6);
    assert.match(sent[4].body, /moved/i);
    assert.equal(sent[5].to, CONTRACTOR);
    assert.match(sent[5].body, /moved/i);
  } finally {
    server.close();
  }
});

test("digest endpoint texts the contractor the day route", async () => {
  const { server, sent, base } = await serve();
  try {
    const res = await fetch(`${base}/internal/digest`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(sent[0].to, CONTRACTOR);
    assert.match(sent[0].body, /route|nothing/i);
  } finally {
    server.close();
  }
});

test("reminder texts the contractor once inside the lead window", async () => {
  const store = createStore(null);
  const sent = [];
  const notify = async ({ to, body }) => sent.push({ to, body });
  const soon = new Date(Date.now() + 20 * 60000).toISOString();
  store.addJob({
    customerId: "c1", contractorId: "k", ambiguousEventId: "e1",
    status: "confirmed", window: { start: soon, end: soon },
    description: "sprinkler repair", source: "message",
  });
  const rem = startReminders({ store, notify, contractorPhone: CONTRACTOR, tz: "UTC", intervalMs: 60000 });
  try {
    await rem.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, CONTRACTOR);
    assert.match(sent[0].body, /running n late/i);
    await rem.tick();
    assert.equal(sent.length, 1);
  } finally {
    rem.stop();
  }
});

test("ai classify parses wrapped JSON and falls back to other on failure", async () => {
  const ai = createAi({
    chat: async () => ({ response: 'Sure! {"intent":"book","dayRef":"thursday"}' }),
    env: { CONTRACTOR_TZ: "UTC" },
  });
  const got = await ai.classify("book me thursday");
  assert.equal(got.intent, "book");
  assert.equal(got.dayRef, "thursday");

  const broken = createAi({ chat: async () => { throw new Error("down"); }, env: {} });
  assert.deepEqual(await broken.classify("hi"), { intent: "other" });
});
