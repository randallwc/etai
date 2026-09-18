NOTIFICATIONS -- calendar reminders to texts
============================================

How a calendar reminder becomes a text. Both reminder paths live in
the service now.

FLOW
----

    Ambiguous upcoming-reminders feed
      -> pollRemoteReminders() in messaging/index.js
         (every REMINDER_POLL_MS, default 60s)
      -> dedup on "cal:"+id, format one line
      -> transport.send to CONTRACT_PHONE

A webhook POST /webhooks/calendar carries the same normalized shape
({ id, kind, summary or event.title, startAt }) and lands in the same
handler, so an Ambiguous push registration works too once the service
has a public URL.

The second path is messaging/reminders.js, which watches the service's
own job store and texts the contractor inside REMINDER_LEAD_MINUTES of
each agent-booked job. The two paths overlap deliberately -- one
covers Ambiguous-side events (workspace UI, other clients), the other
agent-booked jobs.

SOURCE
------

GET /api/calendars/upcoming-reminders?window_hours=N returns reminders
with id, event_id, trigger_at, minutes_before, fired_at, event_title,
event_start_at/end_at, event_status, event_location. Verified live
2026-09-12 -- the feed works and events do carry reminders.

A reminder is forwarded once when trigger_at <= now. Dedup is an
in-memory set ("cal:"+id), so a restart re-delivers a still-due
reminder once -- same caveat as inbound dedup.

ENV
---

  REMINDER_WINDOW_HOURS  lookahead for the remote poll (default 24)
  REMINDER_POLL_MS       remote poll interval (default 60000)
  REMINDER_LEAD_MINUTES  local job-store heads-up window (default 30)
  CONTRACT_PHONE         notification target
  CONTRACTOR_TZ          display timezone
  AMBIG_API              remote poll is skipped without a key

GOTCHAS
-------

The feed only covers events that HAVE reminders. Events created through
messaging/calendar.js do not set one; those are covered by
reminders.js instead.

Notifications go to the contractor only. Client phones for a job live
in the job store; client-facing reminder texts would need a job lookup
per reminder.

Reminders due while the service was down are sent on the next tick --
a late text beats a dropped one -- but only once, bounded by dedup.

TRIED AND REJECTED / UPGRADE PATHS
----------------------------------

Push instead of pull: POST /api/webhooks {url, events:[...]} exists in
the live spec and removes poll lag, but needs a public URL. Pull
first; register a webhook when the service has a stable public
address.

Event diffs instead of the reminder feed: snapshot /calendars/events
and diff for created/updated/canceled. Catches changes the reminder
feed misses; the kind enum already has room for it. Deferred.

GET /api/notifications (workspace feed, mark-read for server-side
dedup) is the other pull source. Empty at test time; revisit if
non-reminder calendar events need texted.
