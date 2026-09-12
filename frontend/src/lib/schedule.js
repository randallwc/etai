const SLOT_MINUTES = 30;
const WORKDAY_END = 17;

export function slotStart(dayOffset, hour, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export function firstFreeSlot(busySlots, dayOffset, hour, now = new Date()) {
  const busy = busySlots.map((s) => ({
    start: new Date(s.start ?? s.start_at),
    end: new Date(s.end ?? s.end_at),
  }));
  const day = new Date(now);
  day.setDate(day.getDate() + dayOffset);
  day.setHours(0, 0, 0, 0);
  let cursor = slotStart(dayOffset, hour, now);
  const dayEnd = new Date(day);
  dayEnd.setHours(WORKDAY_END, 0, 0, 0);
  while (cursor < dayEnd) {
    const end = new Date(cursor.getTime() + SLOT_MINUTES * 60000);
    const clash = busy.some((b) => cursor < b.end && end > b.start);
    if (!clash) return { start: cursor, end };
    cursor = end;
  }
  return null;
}

export function formatSlot({ start }) {
  return start.toLocaleString(undefined, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });
}
