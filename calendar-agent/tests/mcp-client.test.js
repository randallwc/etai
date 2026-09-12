const assert = require("node:assert/strict");
const { test } = require("node:test");
const { formatSummary, readRpcMessage } = require("../main");

test("readRpcMessage picks the matching id from an SSE stream", () => {
  const body = [
    "event: message",
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":7,"result":{"content":[]}}',
    ""
  ].join("\n");
  const message = readRpcMessage(body, 7);
  assert.deepEqual(message.result, { content: [] });
});

test("readRpcMessage parses a plain JSON response", () => {
  const message = readRpcMessage('{"jsonrpc":"2.0","id":2,"result":{"ok":true}}', 2);
  assert.deepEqual(message.result, { ok: true });
});

test("readRpcMessage returns null when no frame matches the id", () => {
  const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n';
  assert.equal(readRpcMessage(body, 9), null);
});

test("formatSummary groups events by day and tags the default calendar", () => {
  const calendars = { data: [{ name: "My Calendar", is_default: true, timezone: "America/Los_Angeles" }] };
  const events = {
    data: [
      { title: "Later", start_at: "2026-09-14T17:00:00.000Z", end_at: "2026-09-14T17:30:00.000Z" },
      { title: "Earlier", start_at: "2026-09-13T15:00:00.000Z", end_at: "2026-09-13T16:00:00.000Z", all_day: false },
      { title: "Offsite", start_at: "2026-09-13T00:00:00.000Z", all_day: true }
    ]
  };
  const out = formatSummary(calendars, events, new Date("2026-09-12T00:00:00Z"), new Date("2026-09-19T00:00:00Z"));
  assert.match(out, /- My Calendar \(default, America\/Los_Angeles\)/);
  assert.match(out, /Events 2026-09-12 to 2026-09-19:/);
  assert.ok(out.indexOf("Earlier") < out.indexOf("Later"), "days sorted chronologically");
  assert.match(out, /all day\s+Offsite/);
});

test("formatSummary tolerates empty results", () => {
  const out = formatSummary({ data: [] }, { data: [] }, new Date("2026-09-12T00:00:00Z"), new Date("2026-09-19T00:00:00Z"));
  assert.match(out, /Calendars:\n\nEvents/);
  assert.match(out, /  none/);
});
