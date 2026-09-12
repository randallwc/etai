RELIABILITY AND CONCURRENCY
============================

The product dies the first time a client's text gets no answer. This file
is the contract for every agent touching the message path: which loops
must never stop, which operations run in parallel, and which are
serialized. See docs/SPEC.md for the module map and docs/GOAL.md for
product intent.

LISTENERS THAT MUST NEVER STOP
------------------------------

  bus subscription      bus/index.js self-subscribes PUBLIC_URL +
                        /webhooks/inbound at MESSAGING_URL on boot and
                        re-POSTs every 30s forever. A messaging restart
                        wipes its subscriber set; the resubscribe loop is
                        the healing path. Never remove this.

  fanout retry buffer   messaging/index.js queues an inbound message that
                        reaches zero live subscribers and re-fans it every
                        FANOUT_RETRY_MS (5s) up to FANOUT_RETRY_MAX (24).
                        Covers the resubscribe gap: a text arriving while
                        the bus is down is delivered, not dropped.
                        /healthz exposes the queue depth as "queued".

  mail poller           messaging/mailpoller.js polls the Ambiguous inbox
                        every MAIL_POLL_SECONDS (15s default, 5s min) and
                        processes the whole batch in parallel. A mail is
                        marked read only after a subscriber accepts it --
                        undelivered mail stays unread and is retried.

  calendar sync         bus/calendar.js mirror: sync() runs at boot, on
                        every /webhooks/calendar hit, and every
                        CALENDAR_SYNC_MS (30s). Guarded by a syncing flag
                        so overlapping triggers collapse to one run.

  reminder tick         bus/reminders.js ticks every 60s and texts the
                        contractor before each job. One notification per
                        job via job.remindedAt.

WHERE THINGS RUN IN PARALLEL
----------------------------

Node's event loop, not worker threads -- every wait is I/O.

  - mailpoller fans an inbox batch out with Promise.all.
  - calendar push drains the pending map concurrently; pull fetches all
    14-day windows in parallel. Ops for the same event id collapse in
    the map, so concurrent pushes are safe.
  - outbound notifications (client + contractor) send independently.
  - Ambiguous fetches are bounded at 60s; classification races a 15s
    timeout (AI_CLASSIFY_TIMEOUT_MS) and falls back to keywords.

WHERE THINGS MUST NOT RACE
--------------------------

  - loop.handle: inbound and voice turns go through one promise chain
    (enqueue in bus/index.js). Two texts on a thread -- "book" then "1" --
    process in arrival order; a slow turn can't wedge the queue because
    each turn is capped at 30s. New entry points must go through the same
    queue, never loop.handle directly.
  - store.dedup is synchronous: externalId claims are atomic at both the
    bus (externalId, cal:id) and messaging layers.
  - messaging accept(): seen + inflight + undelivered checks make a
    redelivery (webhook + poller, or webhook double-post) collapse to one
    fan-out even when the copies arrive concurrently.
  - the calendar rejects a second writer: overlapping confirmed events
    throw {code:"conflict"} and leave state untouched. This is the
    backstop if a race ever slips past the queue.

FAILURE MODES COVERED
---------------------

  messaging restart      subscribers wiped -> resubscribe loop heals;
                         in-flight inbound buffered by the retry queue.
  bus restart            messaging undelivered queue holds texts until
                         the bus returns; state reloads from STATE_FILE.
  Ambiguous slowness     all calls bounded; classify falls back to
                         keywords after 15s; failed calendar pushes
                         re-queue and retry next sync.
  duplicate delivery     dedup at both layers, plus inflight set for
                         concurrent copies.
  stale slot offers      proposals whose slots are all in the past are
                         dropped instead of consumed by the next text.

WHAT WE TRIED AND REJECTED
--------------------------

  - dropping inbound when no subscriber accepts (the old accept()
    semantics): a text arriving mid-restart vanished forever. The retry
    buffer replaced it.
  - replying before dedup: processing first and deduping late double-
    answers redeliveries. Dedup runs before the 202.
  - awaiting loop.handle inside the HTTP handler: a slow classify would
    hold the socket and let a burst of texts interleave anyway. Now the
    202 is immediate and the queue serializes.
  - worker threads / locks: unnecessary -- the only shared mutable state
    is in-process memory, and every hazard is at an await boundary.
