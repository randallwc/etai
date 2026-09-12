const assert = require("node:assert/strict");
const { test } = require("node:test");
const { startReminders } = require("../reminders.js");

const NOW = new Date("2025-06-01T12:00:00Z");
const PHONE = "+15550001111";

function job(id, startIso, extra = {}) {
  return {
    id,
    status: "confirmed",
    description: `fix sink ${id}`,
    window: { start: startIso, end: startIso },
    ...extra,
  };
}

function setup({ jobs = {}, contractorPhone = PHONE, leadMinutes = 30 }) {
  const sent = [];
  const state = { saves: 0 };
  const store = { data: { jobs }, save: () => state.saves++ };
  const r = startReminders({
    store,
    notify: async (m) => sent.push(m),
    contractorPhone,
    tz: "UTC",
    leadMinutes,
    now: () => NOW,
  });
  return { r, sent, store, state };
}

test("tick notifies the contractor when a confirmed job starts within leadMinutes", async (t) => {
  const j = job("j1", "2025-06-01T12:10:00Z");
  const { r, sent, store, state } = setup({ jobs: { j1: j } });
  t.after(() => r.stop());
  await r.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE);
  assert.equal(sent[0].threadKey, PHONE);
  assert.match(sent[0].body, /Next up: fix sink j1/);
  assert.equal(store.data.jobs.j1.remindedAt, NOW.toISOString());
  assert.equal(state.saves, 1);
});

test("tick skips jobs already reminded, canceled, or done", async (t) => {
  const jobs = {
    reminded: job("reminded", "2025-06-01T12:10:00Z", { remindedAt: "2025-06-01T11:00:00Z" }),
    canceled: job("canceled", "2025-06-01T12:10:00Z", { status: "canceled" }),
    done: job("done", "2025-06-01T12:10:00Z", { status: "done" }),
  };
  const { r, sent, state } = setup({ jobs });
  t.after(() => r.stop());
  await r.tick();
  assert.equal(sent.length, 0);
  assert.equal(state.saves, 0);
});

test("tick skips jobs further than leadMinutes away", async (t) => {
  const { r, sent } = setup({ jobs: { j1: job("j1", "2025-06-01T12:45:00Z") } });
  t.after(() => r.stop());
  await r.tick();
  assert.equal(sent.length, 0);
});

test("tick reminds a job 10 minutes past start but not one 25 minutes past", async (t) => {
  const jobs = {
    recent: job("recent", "2025-06-01T11:50:00Z"),
    stale: job("stale", "2025-06-01T11:35:00Z"),
  };
  const { r, sent, store } = setup({ jobs });
  t.after(() => r.stop());
  await r.tick();
  assert.equal(sent.length, 1);
  assert.equal(store.data.jobs.recent.remindedAt, NOW.toISOString());
  assert.equal(store.data.jobs.stale.remindedAt, undefined);
});

test("tick sends nothing when contractorPhone is unset", async (t) => {
  const { r, sent } = setup({
    jobs: { j1: job("j1", "2025-06-01T12:10:00Z") },
    contractorPhone: null,
  });
  t.after(() => r.stop());
  await r.tick();
  assert.equal(sent.length, 0);
});
