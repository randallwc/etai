const DEFAULT_BASE = "https://app.ambiguous.ai";

function createAmbiguous(env = process.env) {
  const base = (env.AMBIGUOUS_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const key = env.AMBIG_API ?? env.AMBIGUOUS_API_KEY;
  const enabled = Boolean(key);

  async function api(path, options = {}) {
    const res = await fetch(`${base}/api${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "API-Version": "1",
        ...(options.headers ?? {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code =
        res.status === 404
          ? "not_found"
          : res.status === 401 || res.status === 403
            ? "auth"
            : "upstream";
      throw Object.assign(new Error(`Ambiguous ${path} -> ${res.status}`), {
        status: res.status,
        code,
      });
    }
    return data;
  }

  return {
    enabled,
    api,
    async users() {
      return (await api("/users")).data ?? [];
    },
    async calendars() {
      return (await api("/calendars")).data ?? [];
    },
    async events(startIso, endIso) {
      return (await api(`/calendars/events?start=${startIso}&end=${endIso}`))
        .data ?? [];
    },
    async busySlots(userId, startIso, endIso) {
      const res = await api(
        `/calendars/availability?user_ids=${userId}&start=${startIso}&end=${endIso}`
      );
      return res?.availability?.[userId] ?? [];
    },
    async createEvent(calendarId, body) {
      const data = await api(`/calendars/${calendarId}/events`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return data.event ?? data;
    },
    async updateEvent(eventId, patch) {
      const data = await api(`/calendars/events/${eventId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return data.event ?? data;
    },
    async deleteEvent(eventId) {
      await api(`/calendars/events/${eventId}`, { method: "DELETE" });
    },
    async createTask(title) {
      const data = await api("/tasks", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      return data.task ?? data;
    },
    async assistantChat(message) {
      return api("/assistant/chat", {
        method: "POST",
        body: JSON.stringify({ message, context: { audience: "agent" } }),
      });
    },
  };
}

module.exports = { createAmbiguous };
