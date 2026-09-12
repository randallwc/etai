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
  if (s === "day after tomorrow") return addDays(today, 2);
  if (s === "next week") return addDays(today, 7);
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
    ...(e.location ? { location: e.location } : {}),
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

function findSlots(busy, date, durationMinutes, count, timePref, tz = "UTC", notBefore = null) {
  const [start, end] = prefBounds(date, timePref, tz);
  const sorted = [...busy]
    .map((b) => ({ start: new Date(b.start ?? b.start_at), end: new Date(b.end ?? b.end_at) }))
    .sort((a, b) => a.start - b.start);
  const need = durationMinutes * 60000;
  const slots = [];
  let cursor = notBefore && notBefore > start ? notBefore : start;
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
 * Slots on or before "today" must start after now plus a short confirm
 * buffer - Ambiguous rejects creates in the past and a slot chosen a few
 * minutes later would land there. Past dates yield no slots so callers
 * fall forward to the next day.
 */
function proposeFromBusy(busy, { date, durationMinutes = 60, count = 3, timePref = null, tz, now }) {
  const notBefore =
    date <= dateStr(partsInTz(tz, now())) ? new Date(now().getTime() + 15 * 60000) : null;
  return findSlots(busy, date, durationMinutes, count, timePref, tz, notBefore);
}

/**
 * Calendar adapter behind the agent loop. When Ambiguous is enabled the
 * adapter is an in-memory mirror over stubCalendar: every loop call (listDay,
 * proposeSlots, create, reschedule, cancel) reads and writes memory, so
 * replies never wait on the API. sync() drains queued writes to Ambiguous
 * concurrently, then pulls remote events in parallel windowed chunks and
 * merges them.
 * Local event ids stay stable for callers; remoteIds translates at push time.
 * With no key, or CALENDAR=memory, the bare stub runs with zero API calls.
 */
function createCalendar({ ambi, env = process.env, now = () => new Date() } = {}) {
  const client = ambi;
  const tz = env.CONTRACTOR_TZ ?? "America/Los_Angeles";
  if (!client?.enabled || env.CALENDAR === "memory") return stubCalendar(tz, now);

  let idsP;
  function ids() {
    idsP ??= (async () => {
      const users = await client.users();
      const userId = (users.find((u) => u.type === "human") ?? users[0])?.id;
      const cals = await client.calendars();
      const calendarId = (cals.find((c) => c.is_default) ?? cals[0])?.id;
      return { userId, calendarId };
    })().catch((e) => {
      idsP = undefined;
      throw e;
    });
    return idsP;
  }

  const mem = stubCalendar(tz, now);
  const pending = new Map();
  const remoteIds = new Map();
  const SYNC_HORIZON_MS = Number(env.CALENDAR_SYNC_DAYS ?? 45) * 864e5;
  const SYNC_CHUNK_MS = 14 * 864e5;

  function enqueue(id, op) {
    if (pending.get(id) === "create" && op === "update") return;
    if (op === "delete" && !remoteIds.has(id)) pending.delete(id);
    else pending.set(id, op);
  }

  let pushing = false;
  function pushSoon() {
    if (pushing) return;
    pushing = true;
    setImmediate(async () => {
      try {
        let prev = -1;
        while (pending.size && pending.size !== prev) {
          prev = pending.size;
          await push();
        }
      } catch (e) {
        console.error(`calendar push: ${e.message}`);
      } finally {
        pushing = false;
      }
    });
  }

  async function createEvent(body) {
    const ev = await mem.createEvent(body);
    pending.set(ev.id, "create");
    pushSoon();
    return ev;
  }

  async function updateEvent(body) {
    const ev = await mem.updateEvent(body);
    enqueue(body.eventId, "update");
    pushSoon();
    return ev;
  }

  async function cancelEvent(body) {
    const ev = await mem.cancelEvent(body);
    enqueue(body.eventId, "delete");
    pushSoon();
    return ev;
  }

  async function apply(ops = []) {
    const results = await mem.apply(ops);
    ops.forEach((op, i) => {
      if (op.op === "create" && results[i]?.id) pending.set(results[i].id, "create");
      else if (op.op === "update") enqueue(op.eventId, "update");
      else if (op.op === "delete" || op.op === "cancel") enqueue(op.eventId, "delete");
    });
    pushSoon();
    return results;
  }

  async function push() {
    await Promise.all(
      [...pending].map(async ([id, op]) => {
        pending.delete(id);
        const ev = mem.events.find((e) => e.id === id);
        try {
          if (op === "create" && ev) {
            const { calendarId: cid } = await ids();
            const remote = await client.createEvent(cid, {
              title: ev.title,
              start_at: ev.start,
              end_at: ev.end,
              description: ev.description,
              ...(ev.location ? { location: ev.location } : {}),
            });
            remoteIds.set(id, remote.id);
            ev.remoteId = remote.id;
          } else if (op === "update" && ev && remoteIds.has(id)) {
            await client.updateEvent(remoteIds.get(id), {
              title: ev.title,
              start_at: ev.start,
              end_at: ev.end,
              description: ev.description,
            });
          } else if (op === "delete" && remoteIds.has(id)) {
            await client.deleteEvent(remoteIds.get(id));
            remoteIds.delete(id);
          }
        } catch (e) {
          pending.set(id, op);
          console.error(`calendar push ${op}: ${e.message}`);
        }
      }),
    );
  }

  async function pull() {
    const t0 = Date.now() - 864e5;
    const end = t0 + SYNC_HORIZON_MS;
    const seen = new Set();
    const chunks = [];
    for (let a = t0; a < end; a += SYNC_CHUNK_MS) chunks.push(a);
    const windows = await Promise.all(
      chunks.map((a) =>
        client.events(
          encodeURIComponent(new Date(a).toISOString()),
          encodeURIComponent(new Date(Math.min(a + SYNC_CHUNK_MS, end)).toISOString()),
        ),
      ),
    );
    for (const remote of windows) {
      for (const r of remote) {
        seen.add(r.id);
        const local = mem.events.find((e) => e.id === r.id || remoteIds.get(e.id) === r.id);
        if (local) {
          if (!pending.has(local.id)) {
            const { id: _rid, ...fields } = normEvent(r);
            Object.assign(local, fields, { remoteId: r.id });
          }
        } else {
          mem.events.push({ ...normEvent(r), remoteId: r.id });
          remoteIds.set(r.id, r.id);
        }
      }
    }
    for (let i = mem.events.length - 1; i >= 0; i--) {
      const e = mem.events[i];
      const rid = remoteIds.get(e.id);
      if (
        rid && !pending.has(e.id) && !seen.has(rid) &&
        e.start < new Date(end).toISOString() && e.end > new Date(t0).toISOString()
      ) {
        remoteIds.delete(e.id);
        mem.events.splice(i, 1);
      }
    }
  }

  let syncing = false;
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      await push();
      await pull();
    } catch (e) {
      console.error(`calendar sync: ${e.message}`);
    } finally {
      syncing = false;
    }
  }

  return {
    stub: false,
    events: mem.events,
    listDay: mem.listDay,
    proposeSlots: mem.proposeSlots,
    createEvent,
    updateEvent,
    cancelEvent,
    apply,
    sync,
    pendingOps: () => pending.size,
  };
}

/**
 * In-memory calendar with the same surface as the Ambiguous adapter.
 * Used as the offline fallback in createCalendar and by all bus tests.
 * apply() runs a batch of creates/updates/deletes in one call.
 */
function stubCalendar(tz = "UTC", now = () => new Date()) {
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
      return proposeFromBusy(busy, { date, durationMinutes, count, timePref, tz, now });
    },
    async createEvent({ title, start, end, description, location }) {
      const ev = {
        id: `stub-${randomUUID()}`,
        title,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        description,
        status: "confirmed",
        ...(location ? { location } : {}),
      };
      const clash = events.find(
        (o) => o.status !== "canceled" && ev.start < o.end && ev.end > o.start
      );
      if (clash) {
        const e = new Error(`overlaps "${clash.title}" at ${clash.start}`);
        e.code = "conflict";
        throw e;
      }
      events.push(ev);
      return ev;
    },
    async updateEvent({ eventId, title, start, end, description, status }) {
      const ev = events.find((e) => e.id === eventId);
      if (!ev) return { id: eventId };
      const nextStart = start ? new Date(start).toISOString() : ev.start;
      const nextEnd = end ? new Date(end).toISOString() : ev.end;
      const nextStatus = status !== undefined ? status : ev.status;
      const clash = events.find(
        (o) => o !== ev && o.status !== "canceled" && nextStatus !== "canceled" && nextStart < o.end && nextEnd > o.start
      );
      if (clash) {
        const e = new Error(`overlaps "${clash.title}" at ${clash.start}`);
        e.code = "conflict";
        throw e;
      }
      if (title !== undefined) ev.title = title;
      ev.start = nextStart;
      ev.end = nextEnd;
      if (description !== undefined) ev.description = description;
      ev.status = nextStatus;
      return ev;
    },
    async cancelEvent({ eventId }) {
      const i = events.findIndex((e) => e.id === eventId);
      return i >= 0 ? events.splice(i, 1)[0] : { id: eventId, status: "canceled" };
    },
    async apply(ops = []) {
      const results = [];
      for (const op of ops) {
        try {
          if (op.op === "create") results.push(await api.createEvent(op));
          else if (op.op === "update") results.push(await api.updateEvent(op));
          else if (op.op === "delete" || op.op === "cancel") results.push(await api.cancelEvent(op));
          else results.push({ error: `unknown op ${op.op}` });
        } catch (e) {
          results.push({ error: e.message });
        }
      }
      return results;
    },
  };
  return api;
}

module.exports = { createCalendar, stubCalendar, resolveDayRef, partsInTz, findSlots };
