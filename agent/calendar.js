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

function dayBounds(date) {
  return [`${date}T00:00:00`, `${date}T23:59:59`];
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

function prefBounds(date, timePref) {
  let start = `${date}T${String(WORK_START).padStart(2, "0")}:00:00`;
  let end = `${date}T${WORK_END}:00:00`;
  if (timePref === "morning") end = `${date}T12:00:00`;
  if (timePref === "afternoon") start = `${date}T13:00:00`;
  if (timePref === "evening") start = `${date}T15:00:00`;
  else if (/^\d{1,2}:\d{2}$/.test(timePref ?? "")) start = `${date}T${timePref}:00`;
  return [new Date(start), new Date(end)];
}

function findSlots(busy, date, durationMinutes, count, timePref) {
  const [start, end] = prefBounds(date, timePref);
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
 * whole agent runs offline.
 */
function createCalendar({ ambi, env = process.env } = {}) {
  const client = ambi;
  if (!client?.enabled) return stubCalendar();

  let userId, calendarId;
  async function ids() {
    if (!userId) userId = (await client.users())[0]?.id;
    if (!calendarId) calendarId = (await client.calendars())[0]?.id;
    return { userId, calendarId };
  }

  return {
    stub: false,
    async listDay({ date }) {
      const [a, b] = dayBounds(date);
      return (await client.events(encodeURIComponent(a), encodeURIComponent(b))).map(normEvent);
    },
    async proposeSlots({ date, durationMinutes = 60, count = 3, timePref = null }) {
      const { userId: uid } = await ids();
      const [a, b] = dayBounds(date);
      const busy = await client.busySlots(uid, a, b);
      return findSlots(busy, date, durationMinutes, count, timePref);
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

function stubCalendar() {
  const events = [];
  return {
    stub: true,
    async listDay({ date }) {
      return events
        .filter((e) => String(e.start).startsWith(date))
        .map(normEvent);
    },
    async proposeSlots({ date, durationMinutes = 60, count = 3, timePref = null }) {
      const busy = events.filter((e) => String(e.start).startsWith(date));
      return findSlots(busy, date, durationMinutes, count, timePref);
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
    async updateEvent({ eventId, start, end }) {
      const ev = events.find((e) => e.id === eventId);
      if (ev) {
        if (start) ev.start = new Date(start).toISOString();
        if (end) ev.end = new Date(end).toISOString();
      }
      return ev ?? { id: eventId };
    },
    async cancelEvent({ eventId }) {
      const i = events.findIndex((e) => e.id === eventId);
      return i >= 0 ? events.splice(i, 1)[0] : { id: eventId, status: "canceled" };
    },
  };
}

module.exports = { createCalendar, stubCalendar, resolveDayRef, partsInTz, findSlots };
