const assert = require("node:assert/strict");
const { test } = require("node:test");
const { stubCalendar } = require("../calendar.js");

const TZ = "America/Los_Angeles";

test("apply runs creates, updates, and deletes in one call", async () => {
  const cal = stubCalendar(TZ);
  const [a, b, c] = await cal.apply([
    { op: "create", title: "Lawn mow - Alvarez", start: "2026-09-14T15:00:00Z", end: "2026-09-14T16:00:00Z" },
    { op: "create", title: "Gutter clean - Ito", start: "2026-09-15T16:00:00Z", end: "2026-09-15T17:00:00Z" },
    { op: "create", title: "Hedge trim - Wallace", start: "2026-09-15T18:00:00Z", end: "2026-09-15T19:00:00Z" },
  ]);
  const moved = await cal.apply([
    { op: "update", eventId: b.id, start: "2026-09-16T16:00:00Z", end: "2026-09-16T17:00:00Z", title: "Gutter clean - Ito (moved)" },
    { op: "delete", eventId: c.id },
  ]);
  assert.equal(moved[0].title, "Gutter clean - Ito (moved)");
  assert.equal(moved[1].id, c.id);
  assert.equal(cal.events.length, 2);

  const mon = await cal.listDay({ date: "2026-09-14" });
  assert.deepEqual(mon.map((e) => e.id), [a.id]);
  const wed = await cal.listDay({ date: "2026-09-16" });
  assert.deepEqual(wed.map((e) => e.id), [b.id]);
});

test("an evening-Pacific job is found on its local day, not the UTC day", async () => {
  const cal = stubCalendar(TZ);
  const ev = await cal.createEvent({
    title: "Late fence repair",
    start: "2026-09-15T02:00:00Z",
    end: "2026-09-15T03:30:00Z",
  });
  assert.deepEqual((await cal.listDay({ date: "2026-09-14" })).map((e) => e.id), [ev.id]);
  assert.deepEqual((await cal.listDay({ date: "2026-09-15" })).map((e) => e.id), []);
});

test("proposeSlots works around in-memory busy events", async () => {
  const cal = stubCalendar(TZ);
  await cal.createEvent({ title: "busy", start: "2026-09-14T16:00:00Z", end: "2026-09-14T17:00:00Z" });
  const slots = await cal.proposeSlots({ date: "2026-09-14", durationMinutes: 60, count: 3 });
  for (const s of slots) {
    assert.ok(
      s.end <= new Date("2026-09-14T16:00:00Z") || s.start >= new Date("2026-09-14T17:00:00Z"),
      `slot ${s.start.toISOString()} overlaps the busy event`,
    );
  }
  await cal.apply([{ op: "cancel", eventId: cal.events[0].id }]);
  const freed = await cal.proposeSlots({ date: "2026-09-14", durationMinutes: 60, count: 1 });
  assert.equal(freed[0].start.toISOString(), "2026-09-14T16:00:00.000Z");
});

test("apply reports unknown ops and keeps going", async () => {
  const cal = stubCalendar();
  const [r1, r2] = await cal.apply([
    { op: "bogus" },
    { op: "create", title: "ok", start: "2026-09-14T16:00:00Z", end: "2026-09-14T17:00:00Z" },
  ]);
  assert.match(r1.error, /unknown op/);
  assert.match(r2.id, /^stub-/);
});
