const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAi } = require("../ai.js");
const { createLoop } = require("../loop.js");
const { createStore } = require("../state.js");
const { stubCalendar } = require("../calendar.js");

const CONTRACTOR = "+15550001111";
const CLIENT = "+15557654321";

const { fallbackClassify } = createAi({ chat: async () => ({}), env: { CONTRACTOR_TZ: "UTC" } });

function makeLoop({ classify, calendar } = {}) {
  const sent = [];
  const store = createStore(null);
  const loop = createLoop({
    calendar: calendar ?? stubCalendar("UTC"),
    ai: { classify: classify ?? (async () => ({ intent: "other" })) },
    store,
    notify: async ({ to, body }) => {
      sent.push({ to, body });
    },
    contractorPhone: CONTRACTOR,
    tz: "UTC",
  });
  const msg = (body, from = CLIENT) => ({
    channel: "sms",
    from,
    body,
    externalId: `n-${Math.random()}`,
    receivedAt: new Date().toISOString(),
    threadKey: from,
  });
  return { loop, store, sent, msg };
}

test("fallbackClassify learns the caller's name from common intros", () => {
  assert.equal(fallbackClassify("hi it's sam, need a locksmith").name, "Sam");
  assert.equal(fallbackClassify("this is dana, need a plumber tomorrow").name, "Dana");
  assert.equal(fallbackClassify("mike here, can you come fix a leak").name, "Mike");
  assert.equal(fallbackClassify("it's sam, where are you").name, "Sam");
  assert.equal(fallbackClassify("it's sam, cancel my visit").name, "Sam");
});

test("fallbackClassify does not mistake common words for names", () => {
  assert.equal(fallbackClassify("it's urgent, need a plumber").name, undefined);
  assert.equal(fallbackClassify("same here").name, undefined);
  assert.equal(fallbackClassify("this is ridiculous").name, undefined);
  assert.equal(fallbackClassify("i'm running 20 late").name, undefined);
});

test("classify keeps a name from the assistant and the prompt asks for it", async () => {
  const prompts = [];
  const ai = createAi({
    chat: async (p) => {
      prompts.push(p);
      return { response: '{"intent":"book","name":"Priya","dayRef":"tomorrow"}' };
    },
    env: { CONTRACTOR_TZ: "UTC" },
    now: () => new Date("2026-01-05T12:00:00Z"),
  });
  const r = await ai.classify("hi it's priya, need a locksmith tomorrow");
  assert.equal(r.intent, "book");
  assert.equal(r.name, "Priya");
  assert.match(prompts[0], /gives their name/);
});

test("classify's regex name survives the fast path when chat is down", async () => {
  const ai = createAi({
    chat: async () => {
      throw new Error("down");
    },
    env: { CONTRACTOR_TZ: "UTC" },
  });
  const r = await ai.classify("it's sam, where are you");
  assert.equal(r.intent, "eta");
  assert.equal(r.name, "Sam");
});

test("a name on any intent lands on the customer record", async () => {
  const { loop, store, msg } = makeLoop({
    classify: async () => ({ intent: "eta", name: "Dana" }),
  });
  await loop.handle(msg("hi it's dana, where are you"));
  assert.equal(store.data.customers[CLIENT].name, "Dana");
});

test("the contractor's own name is not stored as a customer", async () => {
  const { loop, store, msg } = makeLoop({
    classify: async () => ({ intent: "day_summary", name: "Al" }),
  });
  await loop.handle(msg("it's al, what's my day", CONTRACTOR));
  assert.equal(store.data.customers[CONTRACTOR], undefined);
});

test("a booked job uses the learned name in the event title and contractor text", async () => {
  const created = [];
  const calendar = {
    ...stubCalendar("UTC"),
    async createEvent(e) {
      created.push(e);
      return { id: "evt-1", ...e };
    },
  };
  const { loop, store, sent, msg } = makeLoop({
    calendar,
    classify: async () => ({
      intent: "book",
      dayRef: "tomorrow",
      name: "Sam",
      description: "locksmith",
      location: "22 main st",
    }),
  });
  await loop.handle(msg("hi it's sam, need a locksmith tomorrow"));
  await loop.handle(msg("1"));
  assert.equal(store.data.customers[CLIENT].name, "Sam");
  assert.match(created[0].title, /Sam/);
  assert.ok(!created[0].title.includes(CLIENT));
  const toContractor = sent.filter((m) => m.to === CONTRACTOR);
  assert.equal(toContractor.length, 1);
  assert.match(toContractor[0].body, /for Sam/);
  assert.ok(!toContractor[0].body.includes(CLIENT));
});
