import { parseRequest } from "../lib/parseRequest.js";
import { firstFreeSlot, formatSlot } from "../lib/schedule.js";
import { runChecks, summarizeChecks } from "../lib/checks.js";
import { geocode, driveMinutes, precipAt } from "./lookup.js";

const BASE = import.meta.env.DEV ? "/api" : "https://app.ambiguous.ai/api";
const KEY = import.meta.env.VITE_AMBIGUOUS_API_KEY;

export const ambiguousEnabled = Boolean(KEY);

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Ambiguous ${path} -> ${res.status}`);
  return res.json();
}

const THEME_POOL = ["#7c5cff", "#3fae7a", "#3d8bff", "#ff7a59", "#e5b545"];

export function coworkerToPersona(user, i = 0) {
  const name = user.display_name || user.username || "Coworker";
  return {
    id: user.id,
    name,
    role: user.type === "agent" ? "AI Coworker" : "Teammate",
    tagline: `Reachable at ${user.workspace_email || "the workspace"}.`,
    theme: THEME_POOL[i % THEME_POOL.length],
    initials: name[0].toUpperCase(),
    greeting: `Hey, ${name} here. Day summary, or are we adding something new?`,
    summary: null,
    taskAck:
      "Done - it's in Ambiguous now. I'll work it into your schedule.",
    skills: user.focus_areas?.slice(0, 3) ?? ["scheduling", "tasks"],
    voice: { pitch: 0.85 + (i % 5) * 0.12, rate: 1 },
  };
}

export async function fetchCoworkers() {
  if (!ambiguousEnabled) return null;
  const { data } = await api("/users");
  return (data ?? [])
    .filter((u) => u.type === "agent")
    .map(coworkerToPersona);
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function fetchDaySummary() {
  if (!ambiguousEnabled) return null;
  const { start, end } = todayRange();
  const [events, tasks] = await Promise.all([
    api(`/calendars/events?start=${start}&end=${end}`).catch(() => null),
    api("/tasks").catch(() => null),
  ]);
  const evts = events?.data ?? [];
  const open = (tasks?.data ?? []).filter(
    (t) => t.status !== "done" && t.status !== "cancelled"
  );
  const evText = evts.length
    ? `Today: ${evts
        .map(
          (e) =>
            `${e.title} at ${new Date(e.start_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
        )
        .join(", ")}.`
    : "Your calendar is clear today.";
  const taskText = open.length
    ? ` Open tasks: ${open.map((t) => t.title).join(", ")}.`
    : "";
  return evText + taskText;
}

/**
 * Fetch the next two weeks of calendar events plus the CRM contacts the
 * bus upserts on each booking, so the board can show real clients.
 * Returns { events, contacts } or null when no API key is set.
 */
export async function fetchCalendarJobs() {
  if (!ambiguousEnabled) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 14);
  const [eventsRes, contactsRes] = await Promise.all([
    api(
      `/calendars/events?start=${start.toISOString()}&end=${end.toISOString()}`
    ),
    api("/crm/contacts").catch(() => null),
  ]);
  return { events: eventsRes.data ?? [], contacts: contactsRes?.data ?? [] };
}

export async function createTask(title) {
  if (!ambiguousEnabled) return { mocked: true, title };
  const { task } = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return task;
}

async function findUserByName(name) {
  const { data } = await api("/users");
  const needle = name.toLowerCase();
  return (data ?? []).find(
    (u) =>
      u.display_name?.toLowerCase().includes(needle) ||
      u.username?.toLowerCase() === needle
  );
}

async function defaultCalendar() {
  const { data } = await api("/calendars");
  return (data ?? []).find((c) => c.is_default) ?? data?.[0];
}

async function busySlots(userId, start, end) {
  const res = await api(
    `/calendars/availability?user_ids=${userId}&start=${start.toISOString()}&end=${end.toISOString()}`
  );
  return res?.availability?.[userId] ?? [];
}

async function scheduleMeeting(req) {
  const attendee = req.withName
    ? await findUserByName(req.withName).catch(() => null)
    : null;
  const dayStart = new Date();
  dayStart.setDate(dayStart.getDate() + req.dayOffset);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);
  const [calendar, eventsRes, attendeeBusy] = await Promise.all([
    defaultCalendar(),
    api(
      `/calendars/events?start=${dayStart.toISOString()}&end=${dayEnd.toISOString()}`
    ).catch(() => null),
    attendee ? busySlots(attendee.id, dayStart, dayEnd).catch(() => []) : [],
  ]);
  const dayEvents = eventsRes?.data ?? [];
  const slot = firstFreeSlot(
    [...dayEvents, ...attendeeBusy],
    req.dayOffset,
    req.hour
  );
  if (!slot) return "They're fully booked that day. Want me to try another day?";

  const endOf = (e) => new Date(e.end_at ?? e.end);
  const prev = dayEvents
    .filter((e) => {
      const d = endOf(e);
      return !isNaN(d) && d <= slot.start;
    })
    .sort((a, b) => endOf(b) - endOf(a))[0];

  let travelMinutes = null;
  let precipProb = null;
  if (req.location) {
    const geo = await geocode(req.location).catch(() => null);
    if (geo) {
      const [prevGeo, rain] = await Promise.all([
        prev?.location ? geocode(prev.location).catch(() => null) : null,
        precipAt(geo.lat, geo.lon, slot.start).catch(() => null),
      ]);
      precipProb = rain;
      if (prevGeo)
        travelMinutes = await driveMinutes(prevGeo, geo).catch(() => null);
    }
  }
  const checks = runChecks({
    slot,
    prevEnd: prev ? endOf(prev) : null,
    travelMinutes,
    precipProb,
  });

  const who = attendee?.display_name ?? req.withName;
  const title = who
    ? `Meeting with ${who}`
    : req.location
      ? `Job at ${req.location}`
      : "Appointment";
  await api(`/calendars/${calendar.id}/events`, {
    method: "POST",
    body: JSON.stringify({
      title,
      start_at: slot.start.toISOString(),
      end_at: slot.end.toISOString(),
      location: req.location,
      attendees: attendee ? [{ user_id: attendee.id }] : [],
    }),
  });
  const caveat =
    req.withName && !attendee
      ? ` Heads up, ${req.withName} isn't in the workspace yet, so no invite went out.`
      : "";
  const summary = summarizeChecks(checks);
  return `Done - booked for ${formatSlot(slot)}${who ? ` with ${who}` : ""}. ${summary ? summary + " " : ""}${caveat}Is that all?`;
}

function plainReply(text) {
  return text
    .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
    .replace(/([*_`])([\s\S]*?)\1/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:[-*•]|\d{1,2}[.)])[ \t]+/gm, "")
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/\s-\s(?=["'])/g, " ")
    .replace(/—/g, "-")
    .trim();
}

/**
 * Handle one live request from the call: scheduling requests book a real
 * calendar event (resolving the attendee in /users and checking free/busy),
 * anything else goes to the Ambiguous Assistant, which answers with its own
 * workspace tools. Falls back to creating a task when the Assistant is
 * unreachable. Returns the text the agent should speak, or null when no
 * API key is configured (caller uses offlineReply).
 */
export async function handleRequest(text) {
  if (!ambiguousEnabled) return null;
  const req = parseRequest(text);
  if (req.kind === "schedule") return scheduleMeeting(req);
  const reply = await api("/assistant/chat", {
    method: "POST",
    body: JSON.stringify({ message: text, context: { audience: "agent" } }),
  })
    .then((r) => r.response)
    .catch(() => null);
  if (reply) return plainReply(reply);
  const task = await createTask(text);
  return `Done - task "${task?.title ?? text}" is in Ambiguous. Is that all?`;
}

/**
 * Store the finished call transcript as a workspace document so coworkers
 * can read and validate it. Never throws - check `ok` on the result.
 */
export async function sendConversation({ agentId, transcript, endedAt }) {
  if (!ambiguousEnabled) return { ok: true, mocked: true };
  try {
    const doc = await api("/documents", {
      method: "POST",
      body: JSON.stringify({
        type: "doc",
        title: `Call transcript - ${endedAt}`,
        content: `Call with coworker ${agentId}\nEnded ${endedAt}\n\n${transcript}`,
      }),
    });
    return { ok: true, docId: doc.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
