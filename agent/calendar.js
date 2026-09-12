const { randomUUID } = require("node:crypto");
const { createAmbiguous } = require("./ambiguous");

function createCalendar(env = process.env) {
  const key = env.AMBIG_API ?? env.AMBIGUOUS_API_KEY;
  if (!key) return stubCalendar();

  const ambi = createAmbiguous(env);
  let userId, calendarId;

  async function ids() {
    if (!userId) {
      const users = await ambi.users();
      userId = users[0]?.id;
    }
    if (!calendarId) {
      const calendars = await ambi.calendars();
      calendarId = calendars[0]?.id;
    }
    return { userId, calendarId };
  }

  return {
    stub: false,
    async listEvents(startISO, endISO) {
      return ambi.events(encodeURIComponent(startISO), encodeURIComponent(endISO));
    },
    async availability(startISO, endISO) {
      const { userId: uid } = await ids();
      return ambi.busySlots(uid, startISO, endISO);
    },
    async createEvent(input) {
      const { calendarId: cid } = await ids();
      return ambi.createEvent(cid, {
        title: input.title,
        start_at: input.start,
        end_at: input.end,
        description: input.description,
      });
    },
    async updateEvent(id, patch) {
      const body = {};
      if (patch.start) body.start_at = patch.start;
      if (patch.end) body.end_at = patch.end;
      if (patch.description) body.description = patch.description;
      return ambi.updateEvent(id, body);
    },
    async cancelEvent(id) {
      await ambi.deleteEvent(id);
      return { id, status: "canceled" };
    },
  };
}

function stubCalendar() {
  const events = [];
  return {
    stub: true,
    async listEvents() {
      return events;
    },
    async availability() {
      return [];
    },
    async createEvent(input) {
      const event = { id: `stub-${randomUUID()}`, status: "confirmed", ...input };
      events.push(event);
      return event;
    },
    async updateEvent(id, patch) {
      const ev = events.find((e) => e.id === id);
      return ev ? Object.assign(ev, patch) : { id, ...patch };
    },
    async cancelEvent(id) {
      const i = events.findIndex((e) => e.id === id);
      return i >= 0 ? events.splice(i, 1)[0] : { id, status: "canceled" };
    },
  };
}

module.exports = { createCalendar, stubCalendar };
