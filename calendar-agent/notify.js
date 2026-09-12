const SEEN_CAP = 5000;

/**
 * Polls the Ambiguous calendar's upcoming-reminders feed and POSTs each due
 * reminder to the bus as a normalized CalendarNotification
 * (models/calendar-notification.schema.json). The bus owns the text; this
 * side owns Ambiguous. Dedup is in-memory: a restart re-posts a still-due
 * reminder once, same caveat as messaging's dedup.
 */
function createNotifier(env = process.env) {
  const base = (env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
  const apiKey = env.AMBIG_API ?? env.AMBIGUOUS_API_KEY;
  const busUrl = env.BUS_URL?.replace(/\/$/, "");
  const windowHours = Number(env.REMINDER_WINDOW_HOURS) || 24;
  const seen = new Set();

  function markSeen(id) {
    if (seen.size >= SEEN_CAP) seen.delete(seen.values().next().value);
    seen.add(id);
  }

  async function pollOnce(now = new Date()) {
    const res = await fetch(
      `${base}/api/calendars/upcoming-reminders?window_hours=${windowHours}`,
      { headers: { authorization: `Bearer ${apiKey}`, "API-Version": "1" } },
    );
    if (!res.ok) throw new Error(`upcoming-reminders -> ${res.status}`);
    const { reminders = [] } = await res.json().catch(() => ({}));
    let sent = 0;
    for (const r of reminders) {
      if (!r.trigger_at || seen.has(r.id) || new Date(r.trigger_at) > now) continue;
      const notification = {
        id: r.id,
        kind: "reminder",
        eventId: r.event_id ?? null,
        title: r.event_title ?? "event",
        startAt: r.event_start_at ?? null,
        endAt: r.event_end_at ?? null,
        location: r.event_location ?? null,
        triggerAt: r.trigger_at,
        detectedAt: now.toISOString(),
      };
      if (!busUrl) {
        console.log(`[notify] ${notification.title} at ${notification.startAt} (BUS_URL unset)`);
        markSeen(r.id);
        continue;
      }
      const post = await fetch(`${busUrl}/webhooks/calendar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(notification),
      }).catch((e) => {
        console.error(`[notify] bus post failed: ${e.message}`);
        return null;
      });
      if (post?.ok) {
        markSeen(r.id);
        sent += 1;
      }
    }
    return { found: reminders.length, sent };
  }

  function start() {
    const ms = Number(env.POLL_MS) || 60000;
    const timer = setInterval(
      () => pollOnce().catch((e) => console.error(`[notify] poll failed: ${e.message}`)),
      ms,
    );
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }

  return { pollOnce, start, seen };
}

if (require.main === module) {
  require("../shared/env.js").loadEnv();
  const notifier = createNotifier();
  notifier.pollOnce().catch((e) => console.error(`[notify] first poll failed: ${e.message}`));
  notifier.start();
  console.log(`calendar notify polling -> ${process.env.BUS_URL ?? "stdout (BUS_URL unset)"}`);
}

module.exports = { createNotifier };
