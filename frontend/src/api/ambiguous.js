const BASE = import.meta.env.DEV ? "/api" : "https://app.ambiguous.ai/api";
const KEY = import.meta.env.VITE_AMBIGUOUS_API_KEY;

const enabled = Boolean(KEY);

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

/**
 * Fetch the next two weeks of calendar events plus the CRM contacts the
 * service upserts on each booking, so the board can show real clients.
 * Returns { events, contacts } or null when no API key is set.
 */
export async function fetchCalendarJobs() {
  if (!enabled) return null;
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

/**
 * Store the finished call transcript as a workspace document so coworkers
 * can read and validate it. Never throws - check `ok` on the result.
 */
export async function sendConversation({ agentId, transcript, endedAt }) {
  if (!enabled) return { ok: true, mocked: true };
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
