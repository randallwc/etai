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

test("mirror reads memory, pushes writes in a batch, pulls remote changes", async () => {
  const remote = [
    { id: "r1", title: "Lawn mow - Alvarez", start_at: "2026-09-14T15:00:00Z", end_at: "2026-09-14T16:00:00Z", status: "confirmed" },
    { id: "r2", title: "Hedge trim - Wallace", start_at: "2026-09-15T18:00:00Z", end_at: "2026-09-15T19:00:00Z", status: "confirmed" },
  ];
  const pushed = [];
  let seq = 0;
  const ambi = {
    enabled: true,
    users: async () => [{ id: "u1", type: "human" }],
    calendars: async () => [{ id: "c1", is_default: true }],
    events: async () => [...remote],
    createEvent: async (cid, body) => {
      const ev = { id: `remote-${++seq}`, title: body.title, start_at: body.start_at, end_at: body.end_at, status: "confirmed" };
      remote.push(ev);
      pushed.push({ op: "create", body });
      return ev;
    },
    updateEvent: async (id, body) => {
      pushed.push({ op: "update", id, body });
      const r = remote.find((e) => e.id === id);
      if (r) Object.assign(r, body);
      return r ?? { id };
    },
    deleteEvent: async (id) => {
      pushed.push({ op: "delete", id });
      remote.splice(remote.findIndex((e) => e.id === id), 1);
    },
  };
  const cal = createCalendar({ ambi, env: {} });

  await cal.sync();
  assert.equal(cal.events.length, 2);
  assert.deepEqual((await cal.listDay({ date: "2026-09-14" })).map((e) => e.title), ["Lawn mow - Alvarez"]);

  const ev = await cal.createEvent({ title: "Sod install - Kim", start: "2026-09-16T16:00:00Z", end: "2026-09-16T17:00:00Z" });
  await cal.updateEvent({ eventId: "r1", start: "2026-09-14T17:00:00Z", end: "2026-09-14T18:00:00Z" });
  assert.equal(cal.pendingOps(), 2);
  assert.equal(pushed.length, 0);

  await cal.sync();
  assert.deepEqual(pushed.map((p) => p.op).sort(), ["create", "update"]);
  assert.equal(pushed.find((p) => p.op === "create").body.title, "Sod install - Kim");
  assert.equal(pushed.find((p) => p.op === "update").id, "r1");
  assert.equal(cal.pendingOps(), 0);
  assert.equal(cal.events.length, 3);

  remote.splice(remote.findIndex((r) => r.id === "r2"), 1);
  remote.push({ id: "r3", title: "New remote job", start_at: "2026-09-17T16:00:00Z", end_at: "2026-09-17T17:00:00Z", status: "confirmed" });
  await cal.sync();
  assert.equal(cal.events.length, 3);
  assert.ok(cal.events.some((e) => e.id === "r3"));
  assert.ok(!cal.events.some((e) => e.id === "r2"));

  await cal.cancelEvent({ eventId: ev.id });
  await cal.sync();
  assert.deepEqual(pushed.at(-1), { op: "delete", id: "remote-1" });
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
