const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createStore } = require("../state.js");

const NOW_MS = Date.parse("2025-06-01T12:00:00Z");
const win = (start, end) => ({ start, end });

test("dedup returns true once, false on repeat, and evicts the oldest past the cap", () => {
  const store = createStore();
  assert.equal(store.dedup("m1"), true);
  assert.equal(store.dedup("m1"), false);
  for (let i = 0; i < 4999; i++) store.data.seen.push(`s${i}`);
  assert.equal(store.dedup("new"), true);
  assert.equal(store.data.seen.length, 5000);
  assert.equal(store.data.seen[0], "s0");
  assert.equal(store.dedup("s0"), false);
  assert.equal(store.dedup("m1"), true);
  assert.equal(store.dedup("s0"), true);
});

test("upsertCustomer creates then merges fields and persists ambiguousCrmId", () => {
  const store = createStore();
  const c = store.upsertCustomer("+1555", { name: "Jane" });
  assert.match(c.id, /^cust-/);
  assert.equal(c.phone, "+1555");
  assert.equal(c.name, "Jane");
  const again = store.upsertCustomer("+1555", { ambiguousCrmId: "crm-1" });
  assert.equal(again.id, c.id);
  assert.equal(again.name, "Jane");
  assert.equal(store.data.customers["+1555"].ambiguousCrmId, "crm-1");
});

test("addJob assigns an id and keeps the fields", () => {
  const store = createStore();
  const j = store.addJob({ status: "confirmed", customerId: "c1", window: win("a", "b") });
  assert.match(j.id, /^job-/);
  assert.equal(j.status, "confirmed");
  assert.equal(store.data.jobs[j.id], j);
});

test("nextJob picks the earliest confirmed or en_route job whose window has not ended", () => {
  const store = createStore();
  store.addJob({ status: "confirmed", window: win("2025-06-01T13:00:00Z", "2025-06-01T14:00:00Z") });
  const early = store.addJob({ status: "en_route", window: win("2025-06-01T12:30:00Z", "2025-06-01T13:00:00Z") });
  store.addJob({ status: "confirmed", window: win("2025-06-01T10:00:00Z", "2025-06-01T11:00:00Z") });
  store.addJob({ status: "canceled", window: win("2025-06-01T12:05:00Z", "2025-06-01T13:00:00Z") });
  store.addJob({ status: "pending", window: win("2025-06-01T12:05:00Z", "2025-06-01T13:00:00Z") });
  assert.equal(store.nextJob(NOW_MS).id, early.id);
  assert.equal(createStore().nextJob(NOW_MS), null);
});

test("jobForPhone resolves the customer to their latest non-canceled, non-done job", () => {
  const store = createStore();
  assert.equal(store.jobForPhone("+1555"), null);
  const c = store.upsertCustomer("+1555");
  store.addJob({ customerId: c.id, status: "done", window: win("2025-06-01T14:00:00Z", "2025-06-01T15:00:00Z") });
  store.addJob({ customerId: c.id, status: "canceled", window: win("2025-06-01T15:00:00Z", "2025-06-01T16:00:00Z") });
  const live = store.addJob({ customerId: c.id, status: "confirmed", window: win("2025-06-01T13:00:00Z", "2025-06-01T14:00:00Z") });
  store.addJob({ customerId: "other", status: "confirmed", window: win("2025-06-01T16:00:00Z", "2025-06-01T17:00:00Z") });
  assert.equal(store.jobForPhone("+1555").id, live.id);
});

test("setThread merges patches and stamps updatedAt", () => {
  const store = createStore();
  const t = store.setThread("k", { pending: { intent: "book" } });
  assert.equal(t.threadKey, "k");
  assert.equal(t.pending.intent, "book");
  assert.ok(t.updatedAt);
  const t2 = store.setThread("k", { extra: 1 });
  assert.equal(t2.pending.intent, "book");
  assert.equal(t2.extra, 1);
  assert.equal(store.thread("k"), t2);
});

test("logAction appends tool, args, result or error, and createdAt", () => {
  const store = createStore();
  store.logAction({ tool: "calendar_book", args: { slot: 1 }, result: { id: "e1" } });
  store.logAction({ tool: "send", error: "boom" });
  const [a, b] = store.data.actions;
  assert.match(a.id, /^act-/);
  assert.equal(a.tool, "calendar_book");
  assert.deepEqual(a.args, { slot: 1 });
  assert.deepEqual(a.result, { id: "e1" });
  assert.ok(a.createdAt);
  assert.equal(b.error, "boom");
  assert.deepEqual(b.args, {});
});

test("a store reloaded from the same file sees prior mutations", () => {
  const dir = mkdtempSync(join(tmpdir(), "bus-state-"));
  try {
    const file = join(dir, "state.json");
    const s1 = createStore(file);
    s1.dedup("m1");
    const c = s1.upsertCustomer("+1555", { name: "Jane", ambiguousCrmId: "crm-9" });
    const j = s1.addJob({ customerId: c.id, status: "confirmed", window: win("2025-06-01T13:00:00Z", "2025-06-01T14:00:00Z") });
    s1.setThread("k", { pending: 1 });
    s1.logAction({ tool: "t", result: "r" });
    const s2 = createStore(file);
    assert.equal(s2.dedup("m1"), false);
    assert.equal(s2.data.customers["+1555"].ambiguousCrmId, "crm-9");
    assert.equal(s2.data.jobs[j.id].status, "confirmed");
    assert.equal(s2.data.threads.k.pending, 1);
    assert.equal(s2.data.actions.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
