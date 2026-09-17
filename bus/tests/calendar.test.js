const assert = require("node:assert/strict");
const { test } = require("node:test");
const { stubCalendar, createCalendar } = require("../calendar.js");

const TZ = "America/Los_Angeles";

test("createCalendar returns the in-memory stub with no key or CALENDAR=memory", () => {
  assert.equal(createCalendar({ ambi: { enabled: false }, env: {} }).stub, true);
  assert.equal(createCalendar({ ambi: { enabled: true }, env: { CALENDAR: "memory" } }).stub, true);
  assert.equal(createCalendar({ ambi: { enabled: true }, env: {} }).stub, false);
});

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

test("createEvent pushes to Ambiguous on its own; sync() is only the backstop", async () => {
  const pushed = [];
  const ambi = {
    enabled: true,
    users: async () => [{ id: "u1", type: "human" }],
    calendars: async () => [{ id: "c1", is_default: true }],
    createEvent: async (cid, body) => {
      pushed.push({ cid, body });
      return { id: "remote-1", ...body };
    },
  };
  const cal = createCalendar({ ambi, env: {} });
  await cal.createEvent({ title: "Sod install - Kim", start: "2026-09-16T16:00:00Z", end: "2026-09-16T17:00:00Z" });
  assert.equal(pushed.length, 0);
  for (let i = 0; i < 20 && !pushed.length; i++) await new Promise((r) => setImmediate(r));
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].cid, "c1");
  assert.equal(pushed[0].body.title, "Sod install - Kim");
  assert.equal(cal.pendingOps(), 0);
});

test("overlapping creates conflict -- second writer loses", async () => {
  const cal = stubCalendar(TZ);
  const first = await cal.createEvent({ title: "a", start: "2026-09-14T16:00:00Z", end: "2026-09-14T17:00:00Z" });
  const [r1, r2] = await Promise.allSettled([
    cal.createEvent({ title: "b", start: "2026-09-14T16:30:00Z", end: "2026-09-14T17:30:00Z" }),
    cal.createEvent({ title: "c", start: "2026-09-14T16:00:00Z", end: "2026-09-14T16:45:00Z" }),
  ]);
  assert.equal(r1.status, "rejected");
  assert.equal(r2.status, "rejected");
  assert.equal(r1.reason.code, "conflict");
  assert.equal(cal.events.length, 1);
  assert.equal(cal.events[0].id, first.id);
});

test("update into an occupied window throws and leaves the event untouched", async () => {
  const cal = stubCalendar(TZ);
  const [a, b] = await cal.apply([
    { op: "create", title: "a", start: "2026-09-14T16:00:00Z", end: "2026-09-14T17:00:00Z" },
    { op: "create", title: "b", start: "2026-09-14T18:00:00Z", end: "2026-09-14T19:00:00Z" },
  ]);
  await assert.rejects(
    cal.updateEvent({ eventId: b.id, start: "2026-09-14T16:30:00Z", end: "2026-09-14T17:30:00Z" }),
    /overlaps/
  );
  assert.equal(cal.events.find((e) => e.id === b.id).start, "2026-09-14T18:00:00.000Z");
  const ok = await cal.updateEvent({ eventId: b.id, start: "2026-09-14T17:00:00Z", end: "2026-09-14T18:00:00Z" });
  assert.equal(ok.start, "2026-09-14T17:00:00.000Z");
});

test("a clashing op inside apply is an error result, not an abort", async () => {
  const cal = stubCalendar(TZ);
  const [r1, r2, r3] = await cal.apply([
    { op: "create", title: "a", start: "2026-09-14T16:00:00Z", end: "2026-09-14T17:00:00Z" },
    { op: "create", title: "clash", start: "2026-09-14T16:30:00Z", end: "2026-09-14T17:30:00Z" },
    { op: "create", title: "c", start: "2026-09-14T18:00:00Z", end: "2026-09-14T19:00:00Z" },
  ]);
  assert.match(r1.id, /^stub-/);
  assert.match(r2.error, /overlaps/);
  assert.match(r3.id, /^stub-/);
  assert.equal(cal.events.length, 2);
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
