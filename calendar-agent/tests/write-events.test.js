const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createEventFromText, parseEventText } = require("../main");

test("parseEventText accepts a text-only event request", () => {
  assert.deepEqual(
    parseEventText("Team sync | 2026-09-14T10:00:00-07:00 | 90m | review estimates"),
    {
      title: "Team sync",
      start_at: "2026-09-14T17:00:00.000Z",
      end_at: "2026-09-14T18:30:00.000Z",
      description: "review estimates"
    }
  );
});

test("createEventFromText creates an event after checking the calendar", async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === "list_calendars") return { data: [{ id: "cal-1", is_default: true }] };
    if (name === "list_events") return { data: [] };
    return { id: "event-1", ...args };
  };
  const result = await createEventFromText("Team sync | 2026-09-14T10:00:00-07:00 | 60", { call });
  assert.equal(result.status, "created");
  assert.equal(result.event.id, "event-1");
  assert.deepEqual(calls.map(({ name }) => name), ["list_calendars", "list_events", "create_event"]);
  assert.equal(calls[2].args.calendar_id, "cal-1");
});

test("createEventFromText refuses an overlapping event without writing", async () => {
  const calls = [];
  const call = async (name) => {
    calls.push(name);
    if (name === "list_calendars") return { data: [{ id: "cal-1", is_default: true }] };
    return { data: [{ id: "busy", title: "Existing", start_at: "2026-09-14T17:30:00.000Z", end_at: "2026-09-14T18:30:00.000Z" }] };
  };
  const result = await createEventFromText("Team sync | 2026-09-14T10:00:00-07:00 | 60m", { call });
  assert.equal(result.status, "conflict");
  assert.deepEqual(calls, ["list_calendars", "list_events"]);
  assert.equal(result.conflicts[0].id, "busy");
});

test("createEventFromText reports invalid text without calendar calls", async () => {
  const result = await createEventFromText("Team sync tomorrow", { call: async () => assert.fail("should not call") });
  assert.equal(result.status, "invalid");
  assert.match(result.message, /Use:/);
});
