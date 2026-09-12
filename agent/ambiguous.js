const { randomUUID } = require("node:crypto");

/**
 * Thin client over the verified Ambiguous workspace API. When no API key
 * is configured every method falls back to stub data so the agent runs
 * fully offline.
 */
function createAmbiguous(env) {
  const key = env.AMBIG_API ?? env.AMBIGUOUS_API_KEY;
  const base = (env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
  const contractorId = env.CONTRACTOR_USER_ID ?? "contractor";

  async function call(method, path, body) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`ambiguous ${method} ${path} -> ${res.status}: ${data?.error ?? ""}`);
    }
    return data;
  }

  if (!key) {
    const stubEvents = [];
    return {
      stub: true,
      async listEvents() {
        return stubEvents;
      },
      async availability() {
        return [];
      },
      async createEvent(input) {
        const event = { id: `stub-${randomUUID()}`, status: "confirmed", ...input };
        stubEvents.push(event);
        return event;
      },
      async updateEvent(id, patch) {
        const ev = stubEvents.find((e) => e.id === id);
        return ev ? Object.assign(ev, patch) : { id, ...patch };
      },
      async cancelEvent(id) {
        const i = stubEvents.findIndex((e) => e.id === id);
        return i >= 0 ? stubEvents.splice(i, 1)[0] : { id, status: "canceled" };
      },
      async defaultCalendarId() {
        return "stub-calendar";
      },
      contractorId,
    };
  }

  return {
    stub: false,
    async listEvents(startISO, endISO) {
      const data = await call(
        "GET",
        `/calendars/events?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`,
      );
      return data?.data ?? [];
    },
    async availability(startISO, endISO) {
      const data = await call(
        "GET",
        `/calendars/availability?user_ids=${contractorId}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`,
      );
      return data?.availability?.[contractorId] ?? [];
    },
    async createEvent(input) {
      const calendarId = await this.defaultCalendarId();
      return call("POST", `/calendars/${calendarId}/events`, {
        title: input.title,
        start_at: input.start,
        end_at: input.end,
        description: input.description,
        attendees: [{ user_id: contractorId }],
      });
    },
    async updateEvent(id, patch) {
      const body = {};
      if (patch.start) body.start_at = patch.start;
      if (patch.end) body.end_at = patch.end;
      if (patch.description) body.description = patch.description;
      return call("PATCH", `/calendars/events/${id}`, body);
    },
    async cancelEvent(id) {
      return call("DELETE", `/calendars/events/${id}`);
    },
    async defaultCalendarId() {
      const data = await call("GET", "/calendars");
      const calendars = data?.data ?? [];
      return (calendars.find((c) => c.is_default) ?? calendars[0])?.id;
    },
    contractorId,
  };
}

module.exports = { createAmbiguous };
