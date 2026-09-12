require("../shared/env.js").loadEnv();

const apiKey = process.env.AMBIGUOUS_API_KEY;
const baseUrl = (process.env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
const days = Number(process.env.AMBIGUOUS_DAYS) || 7;

let requestId = 0;

function readRpcMessage(body, id) {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const parsed = JSON.parse(trimmed.slice(5));
    if (parsed.id === id) return parsed;
  }
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("{")) return null;
  const parsed = JSON.parse(trimmed);
  return parsed.id === id ? parsed : null;
}

async function rpc(method, params) {
  const id = ++requestId;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MCP ${method} request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const message = readRpcMessage(body, id);
  if (!message) {
    throw new Error(`MCP ${method} returned no matching response`);
  }
  if (message.error) {
    throw new Error(`MCP ${method} error ${message.error.code}: ${message.error.message}`);
  }
  return message.result;
}

async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = (result?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (result?.isError) {
    throw new Error(`${name} failed: ${text || "unknown tool error"}`);
  }
  if (result?.structuredContent !== undefined) {
    return result.structuredContent;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatTimeRange(event) {
  if (event.all_day) {
    return "all day     ";
  }
  const fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
  return `${fmt.format(new Date(event.start_at))} - ${fmt.format(new Date(event.end_at))}`;
}

function formatSummary(calendars, events, from, to) {
  const lines = ["Calendars:"];
  for (const cal of calendars?.data ?? []) {
    const tags = [cal.is_default ? "default" : null, cal.timezone].filter(Boolean).join(", ");
    lines.push(`- ${cal.name}${tags ? ` (${tags})` : ""}`);
  }
  lines.push("", `Events ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}:`);
  const byDay = new Map();
  for (const event of events?.data ?? []) {
    const day = new Date(event.start_at).toDateString();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  }
  const sortedDays = [...byDay.values()].sort(
    (a, b) => new Date(a[0].start_at) - new Date(b[0].start_at)
  );
  if (sortedDays.length === 0) {
    lines.push("  none");
  }
  for (const dayEvents of sortedDays) {
    lines.push(new Date(dayEvents[0].start_at).toDateString());
    for (const event of dayEvents) {
      lines.push(`  ${formatTimeRange(event)}  ${event.title ?? "(untitled)"}`);
    }
  }
  return lines.join("\n");
}

function parseEventText(text) {
  if (typeof text !== "string") throw new Error("Event text must be a string.");
  const [title, startText, durationText, clientName, clientContact, location, ...requestParts] = text.split("|").map((part) => part.trim());
  const request = requestParts.join(" | ");
  if (!title || !startText || !durationText || !clientName || !clientContact || !location || !request) {
    throw new Error("Use: title | 2026-09-14T10:00:00-07:00 | 60m | client name | client contact | location | request");
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(startText)) {
    throw new Error("Start time must include an ISO 8601 timezone offset.");
  }
  const start = new Date(startText);
  const duration = Number(durationText.replace(/\s*(m|min|mins|minutes)$/i, ""));
  if (Number.isNaN(start.getTime()) || !Number.isInteger(duration) || duration < 1 || duration > 1440) {
    throw new Error("Use a valid ISO start time and a duration from 1 to 1440 minutes.");
  }
  const clientEmail = clientContact.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (!clientEmail) throw new Error("Client contact must include an email address for calendar updates.");
  const end = new Date(start.getTime() + duration * 60000);
  return {
    title,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    location,
    description: `Client: ${clientName}\nContact: ${clientContact}\nRequest: ${request}`,
    attendees: [clientEmail]
  };
}

function eventOverlaps(event, request) {
  if (["cancelled", "canceled"].includes(event.status)) return false;
  const start = new Date(event.start_at ?? event.start);
  const end = new Date(event.end_at ?? event.end);
  return start < new Date(request.end_at) && end > new Date(request.start_at);
}

function parseRescheduleText(text) {
  if (typeof text !== "string") throw new Error("Reschedule text must be a string.");
  const [id, startText, durationText] = text.split("|").map((part) => part.trim());
  if (!id || !startText || !durationText || text.split("|").length !== 3) {
    throw new Error("Use: event id | 2026-09-14T10:00:00-07:00 | 60m");
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(startText)) {
    throw new Error("Start time must include an ISO 8601 timezone offset.");
  }
  const start = new Date(startText);
  const duration = Number(durationText.replace(/\s*(m|min|mins|minutes)$/i, ""));
  if (Number.isNaN(start.getTime()) || !Number.isInteger(duration) || duration < 1 || duration > 1440) {
    throw new Error("Use a valid ISO start time and a duration from 1 to 1440 minutes.");
  }
  return { id, start_at: start.toISOString(), end_at: new Date(start.getTime() + duration * 60000).toISOString() };
}

function attendeeEmails(event) {
  const emails = (event?.attendees ?? []).map((attendee) => {
    if (typeof attendee === "string") return attendee;
    return attendee.email ?? attendee.email_address ?? attendee.user?.email;
  });
  return [...new Set(emails.filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}

async function notifyParties(call, emails, subject, body) {
  return Promise.all(emails.map(async (email) => {
    try {
      const message = await call("send_email", { to: [email], subject, body_markdown: body });
      return { email, status: "sent", message };
    } catch (error) {
      return { email, status: "failed", message: error.message };
    }
  }));
}

async function createEventFromText(text, { call = callTool } = {}) {
  let request;
  try {
    request = parseEventText(text);
  } catch (error) {
    return { status: "invalid", request: {}, message: error.message };
  }
  const start = new Date(request.start_at);
  const end = new Date(request.end_at);
  const [calendars, events] = await Promise.all([
    call("list_calendars"),
    call("list_events", {
      start: new Date(start.getTime() - 86400000).toISOString(),
      end: new Date(end.getTime() + 86400000).toISOString(),
      singleEvents: "true",
      orderBy: "startTime"
    })
  ]);
  const conflicts = (events?.data ?? []).filter((event) => eventOverlaps(event, request));
  if (conflicts.length) {
    return {
      status: "conflict",
      request,
      conflicts,
      message: "The requested time overlaps an existing calendar event."
    };
  }
  const calendar = (calendars?.data ?? []).find((item) => item.is_default) ?? calendars?.data?.[0];
  if (!calendar?.id) {
    return { status: "invalid", request, message: "No writable calendar is available." };
  }
  const event = await call("create_event", { calendar_id: calendar.id, ...request });
  const notifications = await notifyParties(
    call,
    request.attendees,
    `Appointment confirmed: ${request.title}`,
    `Your appointment is confirmed.\n\nWhen: ${request.start_at} to ${request.end_at}\nWhere: ${request.location}\n\n${request.description}`
  );
  return { status: notifications.every((notification) => notification.status === "sent") ? "created" : "notification_failed", request, event, notifications };
}

async function rescheduleEventFromText(text, { call = callTool } = {}) {
  let request;
  try {
    request = parseRescheduleText(text);
  } catch (error) {
    return { status: "invalid", request: {}, message: error.message };
  }
  const start = new Date(request.start_at);
  const end = new Date(request.end_at);
  const [current, events] = await Promise.all([
    call("get_event", { id: request.id }),
    call("list_events", {
      start: new Date(start.getTime() - 86400000).toISOString(),
      end: new Date(end.getTime() + 86400000).toISOString(),
      singleEvents: "true",
      orderBy: "startTime"
    })
  ]);
  const attendees = attendeeEmails(current?.data ?? current?.event ?? current);
  if (!attendees.length) {
    return { status: "invalid", request, message: "The event has no attendee email to notify." };
  }
  const conflicts = (events?.data ?? []).filter((event) => event.id !== request.id && eventOverlaps(event, request));
  if (conflicts.length) {
    return {
      status: "conflict",
      request,
      conflicts,
      message: "The requested time overlaps an existing calendar event."
    };
  }
  const event = await call("update_event", request);
  const title = current?.title ?? current?.data?.title ?? "Appointment";
  const notifications = await notifyParties(
    call,
    attendees,
    `Appointment updated: ${title}`,
    `Your appointment has been rescheduled.\n\nNew time: ${request.start_at} to ${request.end_at}`
  );
  return { status: notifications.every((notification) => notification.status === "sent") ? "updated" : "notification_failed", request, event, notifications };
}

async function main() {
  if (!apiKey) {
    throw new Error("Set AMBIGUOUS_API_KEY before running this script.");
  }

  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "calendar-agent", version: "0.1.0" }
  });

  const from = new Date();
  const to = new Date(from.getTime() + days * 86400000);

  const [calendars, events] = await Promise.all([
    callTool("list_calendars"),
    callTool("list_events", {
      start: from.toISOString(),
      end: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime"
    })
  ]);

  console.log(formatSummary(calendars, events, from, to));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { attendeeEmails, main, callTool, createEventFromText, eventOverlaps, formatSummary, notifyParties, parseEventText, parseRescheduleText, readRpcMessage, rescheduleEventFromText, rpc };
