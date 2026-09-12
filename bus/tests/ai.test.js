const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAi, extractJson } = require("../ai.js");

const NOW = new Date("2025-06-01T12:00:00Z");
const makeAi = (chat) => createAi({ chat, env: { CONTRACTOR_TZ: "UTC" }, now: () => NOW });

test("classify parses a valid json response and normalizes it", async () => {
  const prompts = [];
  const ai = makeAi(async (p) => {
    prompts.push(p);
    return { response: 'sure: {"intent":"book","dayRef":"tomorrow","timePref":"afternoon","delayMinutes":"x"}' };
  });
  const r = await ai.classify("need someone tomorrow afternoon");
  assert.equal(r.intent, "book");
  assert.equal(r.dayRef, "tomorrow");
  assert.equal(r.timePref, "afternoon");
  assert.equal(r.delayMinutes, null);
  assert.equal(r.description, null);
  assert.match(prompts[0], /need someone tomorrow afternoon/);
  assert.match(prompts[0], /Today is /);
});

test("classify normalizes an unknown intent to other", async () => {
  const ai = makeAi(async () => ({ response: '{"intent":"fly"}' }));
  assert.equal((await ai.classify("zzz")).intent, "other");
});

test("classify falls back when the response is prose, malformed, or empty", async () => {
  const cases = [
    async () => ({ response: "I cannot help with that" }),
    async () => ({ response: "{bad json" }),
    async () => ({ response: "" }),
    async () => ({}),
    async () => null,
  ];
  for (const chat of cases) {
    const r = await makeAi(chat).classify("cancel my appointment");
    assert.equal(r.intent, "cancel");
  }
});

test("classify falls back when chat throws", async () => {
  const ai = makeAi(async () => {
    throw new Error("down");
  });
  const r = await ai.classify("where are you");
  assert.equal(r.intent, "eta");
});

test("fallbackClassify covers the keyword intents", () => {
  const { fallbackClassify: f } = makeAi(async () => ({}));
  assert.deepEqual(f("running 20 late"), { intent: "running_late", delayMinutes: 20 });
  assert.deepEqual(f("running 15 minutes late"), { intent: "running_late", delayMinutes: 15 });
  assert.deepEqual(f("running late"), { intent: "running_late", delayMinutes: null });
  assert.deepEqual(f("stuck in traffic"), { intent: "running_late", delayMinutes: null });
  assert.deepEqual(f("what's my schedule today"), { intent: "day_summary" });
  assert.deepEqual(f("tomorrow's schedule"), { intent: "day_summary" });
  assert.deepEqual(f("cancel my appointment"), { intent: "cancel" });
  assert.deepEqual(f("can we move it"), { intent: "reschedule" });
  assert.deepEqual(f("push back"), { intent: "reschedule" });
  assert.deepEqual(f("where are you"), { intent: "eta" });
  assert.deepEqual(f("eta?"), { intent: "eta" });
  assert.deepEqual(f("when will you arrive"), { intent: "eta" });
  assert.deepEqual(f("need a plumber to come fix"), {
    intent: "book",
    description: "need a plumber to come fix",
  });
  assert.deepEqual(f("zzz"), { intent: "other" });
});

test("extractJson pulls embedded json out of prose and returns null without braces", () => {
  assert.deepEqual(extractJson('here is it {"a":1} done'), { a: 1 });
  assert.equal(extractJson("no braces here"), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson("{nope}"), null);
});
