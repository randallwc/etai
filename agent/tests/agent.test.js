const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { createAgentServer } = require("../index.js");
const { resolveDayRef } = require("../calendar.js");
const { parseChoice } = require("../loop.js");
const { extractJson } = require("../ai.js");

let server, base;
const sent = [];

function fakeIntent(body) {
  const s = body.toLowerCase();
  if (/what.*day|schedule|route/.test(s)) return { intent: "day_summary" };
  const late = s.match(/running\s+(\d+)?\s*min|running\s+(\d+)?\s*late/);
  if (late) return { intent: "running_late", delayMinutes: +(late[1] ?? late[2] ?? 15) };
  if (/^cancel/.test(s)) return { intent: "cancel" };
  if (/need|book|come|fix/.test(s)) {
    return { intent: "book", dayRef: /thursday/.test(s) ? "thursday" : /tomorrow/.test(s) ? "tomorrow" : null, description: body };
  }
  return { intent: "other" };
}

function inbound(externalId, body, from = "+15551234567") {
  return fetch(`${base}/webhooks/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: "imessage",
      from,
      body,
      externalId,
      receivedAt: new Date().toISOString(),
      threadKey: from,
    }),
  });
}

async function waitForReplies(n) {
  for (let i = 0; i < 50; i++) {
    if (sent.length >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`expected ${n} replies, got ${sent.length}`);
}

before(async () => {
  ({ server } = createAgentServer({}, {
    ai: { classify: async (b) => fakeIntent(b) },
    notify: async ({ to, body }) => {
      sent.push({ to, body });
      return { externalId: `n-${sent.length}` };
    },
  }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("helpers: resolveDayRef, parseChoice, extractJson", () => {
  const now = new Date("2026-09-12T12:00:00");
  assert.match(resolveDayRef("today", "UTC", now), /^2026-09-12$/);
  assert.equal(resolveDayRef("tomorrow", "UTC", now), "2026-09-13");
  assert.match(resolveDayRef("monday", "UTC", now), /^2026-09-14$/);
  const slots = [{ start: "2026-09-14T09:00:00" }, { start: "2026-09-14T10:30:00" }];
  assert.equal(parseChoice("1", slots, "UTC"), 1);
  assert.equal(parseChoice("second", slots, "UTC"), 2);
  assert.equal(parseChoice("9am works", slots, "UTC"), 1);
  assert.equal(parseChoice("nope", slots, "UTC"), null);
  assert.deepEqual(extractJson('{"intent":"book"}'), { intent: "book" });
  assert.equal(extractJson("no json"), null);
});

test("book -> pick a slot -> locked in", async () => {
  const before = sent.length;
  await inbound("b1", "need sprinklers fixed Thursday");
  await waitForReplies(before + 1);
  assert.match(sent.at(-1).body, /reply with a number/i);
  await inbound("b2", "1");
  await waitForReplies(before + 2);
  assert.match(sent.at(-1).body, /locked in/i);
});

test("day summary answers with the route", async () => {
  const before = sent.length;
  await inbound("d1", "what's my day");
  await waitForReplies(before + 1);
  assert.match(sent.at(-1).body, /calendar|route|nothing/i);
});

test("duplicate externalId is processed once", async () => {
  const before = sent.length;
  await inbound("dup-1", "what's my day");
  await inbound("dup-1", "what's my day");
  await waitForReplies(before + 1);
  assert.equal(sent.length, before + 1);
});

test("unknown message gets a help reply", async () => {
  const before = sent.length;
  await inbound("u1", "zzz");
  await waitForReplies(before + 1);
  assert.match(sent.at(-1).body, /what do you need/i);
});
