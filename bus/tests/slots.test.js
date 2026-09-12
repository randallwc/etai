const assert = require("node:assert/strict");
const { test } = require("node:test");
const { stubCalendar, findSlots } = require("../calendar.js");

test("same-day proposals never start before now plus the confirm buffer", async () => {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const cal = stubCalendar("UTC");
  const slots = await cal.proposeSlots({ date, durationMinutes: 60, count: 3 });
  for (const s of slots) {
    assert.ok(s.start.getTime() >= now.getTime() + 15 * 60000);
  }
});

test("a fully past date proposes nothing so callers fall forward", async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const cal = stubCalendar("UTC");
  const slots = await cal.proposeSlots({ date: yesterday, durationMinutes: 60, count: 3 });
  assert.deepEqual(slots, []);
});

test("late in the workday same-day proposals are empty, not past", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const lateNow = new Date(`${today}T23:30:00Z`);
  const slots = findSlots([], today, 60, 3, null, "UTC", lateNow);
  assert.deepEqual(slots, []);
});

test("future dates are unaffected by the clamp", async () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const slots = findSlots([], tomorrow, 60, 3, null, "UTC", new Date());
  assert.equal(slots[0].start.toISOString(), `${tomorrow}T09:00:00.000Z`);
});
