const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createLoop } = require("../loop.js");
const { createStore } = require("../state.js");

const CONTRACTOR = "+15550001111";
const CLIENT = "+15557654321";

const coded = (code) =>
  Object.assign(
    new Error(
      `Ambiguous /calendars/events/evt-1 -> ${code === "auth" ? 401 : code === "not_found" ? 404 : 503}`
    ),
    { code }
  );

function makeLoop({ calendar, classify } = {}) {
  const sent = [];
  const store = createStore(null);
  const loop = createLoop({
    calendar,
    ai: { classify: classify ?? (async () => ({ intent: "cancel" })) },
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
    externalId: `e-${Math.random()}`,
    receivedAt: new Date().toISOString(),
    threadKey: from,
  });
  return { loop, store, sent, msg };
}

function seedJob(store, phone = CLIENT) {
  const cust = store.upsertCustomer(phone, { name: "Sam" });
  const start = new Date(Date.now() + 3600000);
  return store.addJob({
    customerId: cust.id,
    contractorId: "contractor",
    ambiguousEventId: "evt-1",
    status: "confirmed",
    window: {
      start: start.toISOString(),
      end: new Date(start.getTime() + 3600000).toISOString(),
    },
    description: "lock rekey",
    source: "message",
  });
}

test("auth failure tells the client to tell the contractor, no internals", async () => {
  const { loop, store, sent, msg } = makeLoop({
    calendar: { cancelEvent: async () => { throw coded("auth"); } },
  });
  const job = seedJob(store);
  await loop.handle(msg("cancel my visit"));
  assert.match(sent.at(-1).body, /calendar connection needs a new key/i);
  assert.match(sent.at(-1).body, /tell the contractor/i);
  assert.ok(!/401|ambiguous|\/calendars/i.test(sent.at(-1).body));
  assert.equal(job.ambiguousEventId, "evt-1");
});

test("auth failure shows the contractor the underlying error", async () => {
  const { loop, store, sent, msg } = makeLoop({
    calendar: { updateEvent: async () => { throw coded("auth"); } },
    classify: async () => ({ intent: "running_late", delayMinutes: 20 }),
  });
  seedJob(store);
  await loop.handle(msg("running 20 late", CONTRACTOR));
  assert.match(sent.at(-1).body, /new key/i);
  assert.match(sent.at(-1).body, /401/);
});

test("not_found clears the job's event link and tells the client the booking is gone", async () => {
  const { loop, store, sent, msg } = makeLoop({
    calendar: { cancelEvent: async () => { throw coded("not_found"); } },
  });
  const job = seedJob(store);
  await loop.handle(msg("cancel my visit"));
  assert.match(sent.at(-1).body, /isn't on the calendar anymore/i);
  assert.ok(!/404|ambiguous|\/calendars/i.test(sent.at(-1).body));
  assert.equal(store.data.jobs[job.id].ambiguousEventId, null);
  assert.equal(job.status, "confirmed");
});

test("not_found for the contractor clears the acted-on job and shows detail", async () => {
  const { loop, store, sent, msg } = makeLoop({
    calendar: { updateEvent: async () => { throw coded("not_found"); } },
    classify: async () => ({ intent: "running_late", delayMinutes: 10 }),
  });
  const job = seedJob(store);
  await loop.handle(msg("running 10 late", CONTRACTOR));
  assert.match(sent.at(-1).body, /isn't on the calendar anymore/i);
  assert.match(sent.at(-1).body, /404/);
  assert.equal(job.ambiguousEventId, null);
});

test("upstream failures keep the generic try-again reply", async () => {
  const { loop, store, sent, msg } = makeLoop({
    calendar: { cancelEvent: async () => { throw coded("upstream"); } },
  });
  const job = seedJob(store);
  await loop.handle(msg("cancel"));
  assert.match(sent.at(-1).body, /couldn't reach the calendar/i);
  assert.equal(job.ambiguousEventId, "evt-1");
});

test("uncoded tool errors keep the generic reply too", async () => {
  const { loop, store, sent, msg } = makeLoop({
    calendar: { cancelEvent: async () => { throw new Error("socket hangup"); } },
  });
  const job = seedJob(store);
  await loop.handle(msg("cancel"));
  assert.match(sent.at(-1).body, /couldn't reach the calendar/i);
  assert.equal(job.ambiguousEventId, "evt-1");
});
