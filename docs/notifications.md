NOTIFICATIONS -- calendar reminders to the bus
==============================================

Written 2026-09-12. How a calendar reminder becomes a text.

FLOW
----

    Ambiguous upcoming-reminders feed
      -> calendar-agent/notify.js   (poll every POLL_MS, default 60s)
      -> POST {BUS_URL}/webhooks/calendar
      -> bus dedups, formats one line
      -> POST {MESSAGING_URL}/send to CONTRACT_PHONE

The calendar side owns everything Ambiguous; the bus stays a router. The
shape crossing the boundary is models/calendar-notification.schema.json.

SOURCE
------

GET /api/calendars/upcoming-reminders?window_hours=N returns reminders
with id, event_id, trigger_at, minutes_before, fired_at, event_title,
event_start_at/end_at, event_status, event_location. Verified live
2026-09-12 -- the feed works and events do carry reminders.

The poller forwards a reminder once when trigger_at <= now. Dedup is an
in-memory set on both sides (poller on reminder id, bus on "cal:"+id), so
a restart re-delivers a still-due reminder once -- same caveat as
messaging's dedup. A notification is only marked seen when the bus
answers 2xx, so a down bus retries next poll instead of dropping.

ENV
---

  calendar-agent:  BUS_URL, POLL_MS, REMINDER_WINDOW_HOURS (default 24),
                   AMBIG_API/AMBIGUOUS_API_KEY
  bus:             CONTRACT_PHONE (target), CONTRACTOR_TZ (display time),
                   MESSAGING_URL

Run it: `node calendar-agent/notify.js` alongside the bus and messaging.
With BUS_URL unset the poller logs reminders to stdout instead of
posting -- that is the offline mode.

GOTCHAS
-------

The feed only covers events that HAVE reminders. Events created through
bus/calendar.js do not set one; those are covered by bus/reminders.js
instead, which watches the agent's own job store. The two paths overlap
deliberately -- one covers Ambiguous-side events (frontend call UI,
workspace UI), the other agent-booked jobs.

Notifications go to the contractor only. Client phones for a job live in
the agent's job store, which the bus cannot see -- client-facing reminder
texts would need the agent as a stop or a job lookup endpoint.

Reminders due while the poller was down are sent on the next tick --
a late text beats a dropped one -- but only once, bounded by dedup.

TRIED AND REJECTED / UPGRADE PATHS
----------------------------------

Push instead of pull: POST /api/webhooks {url, events:[...]} exists in the
live spec (see /api/webhooks/event-types) and removes poll lag, but needs
a public URL for the bus. Pull first; register a webhook when the bus has
a stable public address.

Event diffs instead of the reminder feed: snapshot /calendars/events and
diff for created/updated/canceled. Catches changes the reminder feed
misses; the schema's kind enum already has room for it. Deferred -- more
code for a case the demo does not need.

GET /api/notifications (workspace feed, mark-read for server-side dedup)
is the other pull source. Empty at test time; revisit if non-reminder
calendar events need texted.
