const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createEventFromText, parseEventText, parseRescheduleText, rescheduleEventFromText } = require("../main");

test("parseEventText accepts a text-only event request", () => {
  assert.deepEqual(
    parseEventText("Sprinkler repair | 2026-09-14T10:00:00-07:00 | 90m | Rosa Alvarez | +15551234567 | 412 Willow St | Replace leaking valve"),
    {
      title: "Sprinkler repair",
      start_at: "2026-09-14T17:00:00.000Z",
      end_at: "2026-09-14T18:30:00.000Z",
      location: "412 Willow St",
      description: "Client: Rosa Alvarez\nContact: +15551234567\nRequest: Replace leaking valve"
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
  const result = await createEventFromText("Sprinkler repair | 2026-09-14T10:00:00-07:00 | 60 | Rosa Alvarez | +15551234567 | 412 Willow St | Replace leaking valve", { call });
  assert.equal(result.status, "created");
  assert.equal(result.event.id, "event-1");
  assert.deepEqual(calls.map(({ name }) => name), ["list_calendars", "list_events", "create_event"]);
  assert.equal(calls[2].args.calendar_id, "cal-1");
  assert.equal(calls[2].args.location, "412 Willow St");
  assert.match(calls[2].args.description, /Client: Rosa Alvarez/);
  assert.match(calls[2].args.description, /Request: Replace leaking valve/);
});

test("createEventFromText refuses an overlapping event without writing", async () => {
  const calls = [];
  const call = async (name) => {
    calls.push(name);
    if (name === "list_calendars") return { data: [{ id: "cal-1", is_default: true }] };
    return { data: [{ id: "busy", title: "Existing", start_at: "2026-09-14T17:30:00.000Z", end_at: "2026-09-14T18:30:00.000Z" }] };
  };
  const result = await createEventFromText("Sprinkler repair | 2026-09-14T10:00:00-07:00 | 60m | Rosa Alvarez | +15551234567 | 412 Willow St | Replace leaking valve", { call });
  assert.equal(result.status, "conflict");
  assert.deepEqual(calls, ["list_calendars", "list_events"]);
  assert.equal(result.conflicts[0].id, "busy");
});

test("createEventFromText reports invalid text without calendar calls", async () => {
  const result = await createEventFromText("Team sync tomorrow", { call: async () => assert.fail("should not call") });
  assert.equal(result.status, "invalid");
  assert.match(result.message, /Use:/);
});

test("parseRescheduleText accepts an event ID, start time, and duration", () => {
  assert.deepEqual(
    parseRescheduleText("event-1 | 2026-09-14T13:00:00-07:00 | 30m"),
    { id: "event-1", start_at: "2026-09-14T20:00:00.000Z", end_at: "2026-09-14T20:30:00.000Z" }
  );
});

test("rescheduleEventFromText updates a clear time and ignores its own event", async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === "list_events") {
      return { data: [{ id: "event-1", start_at: "2026-09-14T20:00:00.000Z", end_at: "2026-09-14T20:30:00.000Z" }] };
    }
    return { id: args.id, ...args };
  };
  const result = await rescheduleEventFromText("event-1 | 2026-09-14T13:00:00-07:00 | 30m", { call });
  assert.equal(result.status, "updated");
  assert.deepEqual(calls.map(({ name }) => name), ["list_events", "update_event"]);
  assert.equal(calls[1].args.id, "event-1");
});

test("rescheduleEventFromText refuses a conflict without updating", async () => {
  const calls = [];
  const call = async (name) => {
    calls.push(name);
    return { data: [{ id: "event-2", start_at: "2026-09-14T20:15:00.000Z", end_at: "2026-09-14T20:45:00.000Z" }] };
  };
  const result = await rescheduleEventFromText("event-1 | 2026-09-14T13:00:00-07:00 | 30m", { call });
  assert.equal(result.status, "conflict");
  assert.deepEqual(calls, ["list_events"]);
});
