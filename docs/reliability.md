RELIABILITY AND CONCURRENCY
===========================

The product dies the first time a client's text gets no answer. This
file records which loops must never stop, which operations run in
parallel, and which are serialized. See docs/messaging.md for the
module map -- there is one service now, so "restart" means the whole
thing.

LISTENERS THAT MUST NEVER STOP
------------------------------

  mail poller           messaging/mailpoller.js polls the Ambiguous
                        inbox every MAIL_POLL_SECONDS (15s default) and
                        feeds each item through the same accept() path
                        as the webhooks. Consumed items are marked read
                        after processing, so a crash re-delivers at
                        most once (dedup covers it).

  calendar sync         messaging/calendar.js mirror: sync() runs at
                        boot, on every /webhooks/calendar hit, and
                        every CALENDAR_SYNC_MS (30s). Guarded by a
                        syncing flag so overlapping triggers collapse
                        to one run.

  reminder ticks        messaging/reminders.js ticks every 60s and
                        texts the contractor before each agent-booked
                        job (job.remindedAt fires once). The remote
                        upcoming-reminders poll runs every
                        REMINDER_POLL_MS for Ambiguous-side events.

WHERE THINGS RUN IN PARALLEL
----------------------------

Node's event loop, not worker threads -- every wait is I/O.

  - mailpoller processes an inbox batch with Promise.all.
  - calendar push drains the pending map concurrently; pull fetches
    all 14-day windows in parallel. Ops for the same event id collapse
    in the map, so concurrent pushes are safe.
  - outbound notifications (client + contractor) send independently.
  - Ambiguous fetches are bounded; classification races a timeout
    (AI_CLASSIFY_TIMEOUT_MS) and falls back to keywords.

WHERE THINGS MUST NOT RACE
--------------------------

  - loop.handle: inbound and voice turns go through one promise chain
    per threadKey (enqueue in messaging/index.js). Two texts on a
    thread -- "book" then "1" -- process in arrival order. The
    /voice/turn timeout (TURN_TIMEOUT_MS) only bounds the
    caller-facing reply; the queued turn still runs to completion and
    its texts go out. New entry points must go through the same queue,
    never loop.handle directly.
  - store.dedup is synchronous: externalId claims are atomic for both
    messages and calendar ids ("cal:"+id).
  - the calendar rejects a second writer: overlapping confirmed events
    throw {code:"conflict"} and leave state untouched. Backstop if a
    race ever slips past the queue.

FAILURE MODES COVERED
---------------------

  service restart        in-memory dedup and the recent list reset;
                         state reloads from STATE_FILE; a redelivered
                         webhook can be processed once more.
  Ambiguous slowness     all calls bounded; classify falls back to
                         keywords; failed calendar pushes re-queue and
                         retry next sync.
  duplicate delivery     dedup on externalId before the 202.
  stale slot offers      proposals whose slots are all in the past are
                         dropped instead of consumed by the next text.

WHAT WE TRIED AND REJECTED
--------------------------

  - replying before dedup: processing first and deduping late double-
    answers redeliveries. Dedup runs before the 202.
  - awaiting loop.handle inside the HTTP handler: a slow classify
    would hold the socket and let a burst of texts interleave anyway.
    The 202 is immediate and the per-thread queue serializes.
  - a separate fanout layer with a persisted undelivered queue: the
    merged service removed the HTTP hop entirely, so there is no
    subscriber to lose a message to. Inbound arrives only through
    transports this process owns.
  - worker threads / locks: unnecessary -- the only shared mutable
    state is in-process memory, and every hazard is at an await
    boundary.
