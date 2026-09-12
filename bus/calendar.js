const { randomUUID } = require("node:crypto");

const WORK_START = 9;
const WORK_END = 17;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function partsInTz(tz, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { weekday: get("weekday").toLowerCase(), y: +get("year"), m: +get("month"), d: +get("day") };
}

function dateStr(p) {
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function addDays(dateStr_, n) {
  const [y, m, d] = dateStr_.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Resolves an intent dayRef ("today", "tomorrow", weekday name, or
 * YYYY-MM-DD) to a YYYY-MM-DD string in the contractor's timezone.
 */
function resolveDayRef(dayRef, tz, now) {
  const today = dateStr(partsInTz(tz, now));
  if (!dayRef) return today;
  const s = String(dayRef).trim().toLowerCase();
  if (s === "today") return today;
  if (s === "tomorrow") return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const target = WEEKDAYS.indexOf(s);
  if (target >= 0) {
    const todayIdx = WEEKDAYS.indexOf(partsInTz(tz, now).weekday);
    const delta = (target - todayIdx + 7) % 7 || 7;
    return addDays(today, delta);
  }
  return today;
}

function wallUtc(tz, instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(instant);
  const get = (t) => +parts.find((p) => p.type === t).value;
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
}

function localToUtc(date, hhmmss, tz) {
  const target = Date.parse(`${date}T${hhmmss}Z`);
  let guess = target;
  for (let i = 0; i < 2; i++) guess = target - (wallUtc(tz, new Date(guess)) - guess);
  return new Date(guess);
}

function dayBounds(date, tz) {
  return [
    localToUtc(date, "00:00:00", tz).toISOString(),
    localToUtc(addDays(date, 1), "00:00:00", tz).toISOString(),
  ];
}

function normEvent(e) {
  return {
    id: e.id,
    title: e.title ?? "job",
    start: e.start ?? e.start_at,
    end: e.end ?? e.end_at,
    status: e.status ?? "confirmed",
  };
}

function prefBounds(date, timePref, tz) {
  let start = `${String(WORK_START).padStart(2, "0")}:00`;
  let end = `${WORK_END}:00`;
  if (timePref === "morning") end = "12:00";
  else if (timePref === "afternoon") start = "13:00";
  else if (timePref === "evening") start = "15:00";
  else if (/^\d{1,2}:\d{2}$/.test(timePref ?? "")) start = timePref;
  return [localToUtc(date, `${start}:00`, tz), localToUtc(date, `${end}:00`, tz)];
}

function findSlots(busy, date, durationMinutes, count, timePref, tz = "UTC") {
  const [start, end] = prefBounds(date, timePref, tz);
  const sorted = [...busy]
    .map((b) => ({ start: new Date(b.start ?? b.start_at), end: new Date(b.end ?? b.end_at) }))
    .sort((a, b) => a.start - b.start);
  const need = durationMinutes * 60000;
  const slots = [];
  let cursor = start;
  for (const b of sorted) {
    while (cursor.getTime() + need <= Math.min(b.start.getTime(), end.getTime()) && slots.length < count) {
      slots.push({ start: new Date(cursor), end: new Date(cursor.getTime() + need) });
      cursor = new Date(cursor.getTime() + need + 30 * 60000);
    }
    if (b.end > cursor) cursor = b.end;
  }
  while (cursor.getTime() + need <= end.getTime() && slots.length < count) {
    slots.push({ start: new Date(cursor), end: new Date(cursor.getTime() + need) });
    cursor = new Date(cursor.getTime() + need + 30 * 60000);
  }
  return slots;
}

/**
 * Calendar adapter behind the agent loop. When Ambiguous is enabled it maps
 * the raw client surface (users/calendars/events/busySlots/CRUD) to the
 * loop's needs; with no API key it falls back to an in-memory stub so the
 * whole agent runs offline. CALENDAR=memory forces the stub even when an
 * Ambiguous key is present -- the whole stack runs with zero API calls.
 */
function createCalendar({ ambi, env = process.env } = {}) {
  const client = ambi;
  const tz = env.CONTRACTOR_TZ ?? "America/Los_Angeles";
  if (!client?.enabled || env.CALENDAR === "memory") return stubCalendar(tz);

  let userId, calendarId;
  async function ids() {
    if (!userId) {
      const users = await client.users();
      userId = (users.find((u) => u.type === "human") ?? users[0])?.id;
    }
    if (!calendarId) {
      const cals = await client.calendars();
      calendarId = (cals.find((c) => c.is_default) ?? cals[0])?.id;
    }
    return { userId, calendarId };
  }

  return {
    stub: false,
    async listDay({ date }) {
      const [a, b] = dayBounds(date, tz);
      return (await client.events(encodeURIComponent(a), encodeURIComponent(b))).map(normEvent);
    },
    async proposeSlots({ date, durationMinutes = 60, count = 3, timePref = null }) {
      const { userId: uid } = await ids();
      if (!uid) throw new Error("no Ambiguous user for availability");
      const [a, b] = dayBounds(date, tz);
      const busy = await client.busySlots(uid, a, b);
      return findSlots(busy, date, durationMinutes, count, timePref, tz);
    },
    async createEvent({ title, start, end, description }) {
      const { calendarId: cid } = await ids();
      return client.createEvent(cid, {
        title,
        start_at: new Date(start).toISOString(),
        end_at: new Date(end).toISOString(),
        description,
      });
    },
    async updateEvent({ eventId, start, end }) {
      const body = {};
      if (start) body.start_at = new Date(start).toISOString();
      if (end) body.end_at = new Date(end).toISOString();
      return client.updateEvent(eventId, body);
    },
    async cancelEvent({ eventId }) {
      await client.deleteEvent(eventId);
      return { id: eventId, status: "canceled" };
    },
  };
}

/**
 * In-memory calendar with the same surface as the Ambiguous adapter.
 * Used as the offline fallback in createCalendar and by all bus tests.
 * apply() runs a batch of creates/updates/deletes in one call.
 */
function stubCalendar(tz = "UTC") {
  const events = [];
  function overlapsDay(e, date) {
    const [a, b] = dayBounds(date, tz);
    return e.start < b && e.end > a;
  }
  const api = {
    stub: true,
    events,
    async listDay({ date }) {
      return events.filter((e) => overlapsDay(e, date)).map(normEvent);
    },
    async proposeSlots({ date, durationMinutes = 60, count = 3, timePref = null }) {
      const busy = events.filter((e) => e.status !== "canceled" && overlapsDay(e, date));
      return findSlots(busy, date, durationMinutes, count, timePref, tz);
    },
    async createEvent({ title, start, end, description }) {
      const ev = {
        id: `stub-${randomUUID()}`,
        title,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        description,
        status: "confirmed",
      };
      events.push(ev);
      return ev;
    },
    async updateEvent({ eventId, title, start, end, description, status }) {
      const ev = events.find((e) => e.id === eventId);
      if (ev) {
        if (title !== undefined) ev.title = title;
        if (start) ev.start = new Date(start).toISOString();
        if (end) ev.end = new Date(end).toISOString();
        if (description !== undefined) ev.description = description;
        if (status !== undefined) ev.status = status;
      }
      return ev ?? { id: eventId };
    },
    async cancelEvent({ eventId }) {
      const i = events.findIndex((e) => e.id === eventId);
      return i >= 0 ? events.splice(i, 1)[0] : { id: eventId, status: "canceled" };
    },
    async apply(ops = []) {
      const results = [];
      for (const op of ops) {
        if (op.op === "create") results.push(await api.createEvent(op));
        else if (op.op === "update") results.push(await api.updateEvent(op));
        else if (op.op === "delete" || op.op === "cancel") results.push(await api.cancelEvent(op));
        else results.push({ error: `unknown op ${op.op}` });
      }
      return results;
    },
  };
  return api;
}

module.exports = { createCalendar, stubCalendar, resolveDayRef, partsInTz, findSlots };
