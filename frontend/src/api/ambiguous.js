import { parseRequest } from "../lib/parseRequest.js";
import { firstFreeSlot, formatSlot } from "../lib/schedule.js";

const BASE = "https://app.ambiguous.ai/api";
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
      "Done — it's in Ambiguous now. I'll work it into your schedule.",
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
  const busy = attendee
    ? await busySlots(attendee.id, dayStart, dayEnd).catch(() => [])
    : [];
  const slot = firstFreeSlot(busy, req.dayOffset, req.hour);
  if (!slot) return "They're fully booked that day. Want me to try another day?";
  const calendar = await defaultCalendar();
  const who = attendee?.display_name ?? req.withName;
  await api(`/calendars/${calendar.id}/events`, {
    method: "POST",
    body: JSON.stringify({
      title: who ? `Meeting with ${who}` : "Meeting",
      start_at: slot.start.toISOString(),
      end_at: slot.end.toISOString(),
      attendees: attendee ? [{ user_id: attendee.id }] : [],
    }),
  });
  const caveat =
    req.withName && !attendee
      ? ` — heads up, ${req.withName} isn't in the workspace yet, so no invite went out`
      : "";
  return `Done — meeting is scheduled${who ? ` with ${who}` : ""} for ${formatSlot(slot)}, based on availability${caveat}. Is that all?`;
}

/**
 * Handle one live request from the call: scheduling requests book a real
 * calendar event (resolving the attendee in /users and checking free/busy),
 * anything else becomes a task. Returns the text the agent should speak,
 * or null when no API key is configured (caller uses offlineReply).
 */
export async function handleRequest(text) {
  if (!ambiguousEnabled) return null;
  const req = parseRequest(text);
  if (req.kind === "schedule") return scheduleMeeting(req);
  const task = await createTask(text);
  return `Done — task "${task?.title ?? text}" is in Ambiguous. Is that all?`;
}

/**
 * Store the finished call transcript as a workspace document so coworkers
 * can read and validate it. Never throws — check `ok` on the result.
 */
export async function sendConversation({ agentId, transcript, endedAt }) {
  if (!ambiguousEnabled) return { ok: true, mocked: true };
  try {
    const doc = await api("/documents", {
      method: "POST",
      body: JSON.stringify({
        type: "doc",
        title: `Call transcript — ${endedAt}`,
        content: `Call with coworker ${agentId}\nEnded ${endedAt}\n\n${transcript}`,
      }),
    });
    return { ok: true, docId: doc.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
