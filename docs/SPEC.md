ETAi SPEC -- the contract for agents building on this repo
==========================================================

ETAi is a headless scheduling agent for blue-collar contractors. It lives
inside the channels clients already use -- SMS, iMessage, voice -- not in
a chat UI. Text in, AI reads it, the calendar is updated, both parties
get a text back. This file is the authoritative contract; per-module docs
sit next to it (bus.md, messaging.md, calendar-agent.md, conversation.md,
ambiguous-integration.md).

SERVICES AND BOUNDARIES
-----------------------

  messaging/   Transports and inbound normalization only. Owns
               BlueBubbles/iMessage, ambimail (Ambiguous mail through
               carrier email->SMS gateways), the sim transport, the
               mailpoller, and subscriber fan-out. Port :4020.
               It must never decide anything; it delivers normalized
               messages and sends outbound text. Exactly one consumer
               may subscribe to /webhooks/inbound -- that consumer is
               the bus. Two subscribers means double replies.

  bus/         The one brain. Owns intent classification, conversation
               state, the calendar adapter, all business replies, and
               every notification to client or contractor. Port :4010.
               Receives inbound at POST /webhooks/inbound and Ambiguous
               calendar notifications at /webhooks/calendar. Voice
               turns enter at /voice/turn and get a synchronous reply.

  calendar-agent/ (if present)  Polls Ambiguous for calendar changes and
               reminders and forwards them to the bus's /webhooks/calendar.
               It notifies; it does not reply to people.

  frontend/    Dispatcher board + call UI. Talks to Ambiguous directly
               for reads and to messaging /send for outbound texts.

THE MESSAGE PIPELINE
--------------------

  phone --SMS--> carrier gateway --email--> Ambiguous mail inbox
    --> mailpoller (5s poll, MAIL_POLL_SECONDS) or email.received webhook
    --> messaging normalizes {channel, from, body, externalId, receivedAt,
        threadKey}
    --> bus /webhooks/inbound --> dedup --> enqueue --> loop.handle
    --> ai.classify(text, ctx) --> intent JSON
    --> calendar tools (memory mirror) --> notify() --> messaging /send
    --> ambimail --> phone

ctx for classify carries channel, role (client/contractor), the texter's
customer record, their active jobs, the pending proposal/clarification,
and the last 8 thread history entries. The intent contract is
models/intent.schema.json: book, day_summary, running_late, cancel,
reschedule, eta, clarify, other -- plus dayRef, timePref,
durationMinutes, delayMinutes, name, description, jobRef, question, say,
slotChoice. clarify asks instead of guessing; other uses the
model-drafted say text. Every inbound gets a reply -- silence is a bug.

THE CALENDAR -- IN-MEMORY MIRROR
--------------------------------

createCalendar returns one of two shapes:

  mirror (Ambiguous configured): an in-memory copy of the real calendar.
  Every loop call -- listDay, proposeSlots, createEvent, updateEvent,
  cancelEvent, apply -- reads and writes memory, so replies never wait
  on the API. Writes enqueue into a pending map; sync() drains it to
  Ambiguous concurrently, then pulls remote events in parallel 14-day
  windows across a CALENDAR_SYNC_DAYS horizon (default 45) and merges.
  remoteIds translates local stub ids to remote ids at push time, so
  loop-side job.ambiguousEventId stays stable. sync() runs at boot, on
  every /webhooks/calendar event, and every CALENDAR_SYNC_MS (30s).

  stub (no AMBIG_API, or CALENDAR=memory): the same surface with zero
  API calls. This is what every test and the sim path uses.

Invariants the mirror keeps:

  - no overlapping confirmed events; createEvent/updateEvent throw
    {code:"conflict"} and leave state untouched -- the loop turns that
    into a "that time's taken" reply, never a crash.
  - apply(ops) runs creates/updates/deletes in one call, in order, and
    returns a result or {error} per op without aborting.
  - canceled events are excluded from proposeSlots; deletes of events
    never pushed upstream drop out of pending entirely.
  - a failed push re-queues the op; sync() is guarded against
    re-entrance.

CONCURRENCY MODEL
-----------------

Texts arrive in bursts (the mailpoller fans a whole inbox out in
parallel). Two rules keep the calendar a single source of truth:

  - The bus serializes turns: /webhooks/inbound and /voice/turn run
    loop.handle through one promise queue, so two texts on the same
    thread (or two clients grabbing the same slot) are processed one at
    a time, in arrival order.
  - The calendars are the backstop: the overlap guard rejects a second
    writer even if a race slips past the queue.

On the outbound side the reverse holds: mailpoller fan-out, calendar
push, and calendar pull are all Promise.all -- reads and notifications
are parallel, writes to shared state are serialized or overlap-guarded.
Messaging keeps an undelivered queue (FANOUT_RETRY_MS/MAX) so a
temporarily-dead bus never loses a text; seen + inflight dedup covers
both sequential and concurrent redelivery.

MESSAGING DETAILS THAT BITE
---------------------------

  - mail.send silently drops body_text alone; always send body_markdown
    AND body_text or the phone shows only the "(ETAi)" subject.
  - Real inbound mail uses senderEmail/bodyFull/bodyPreview, not
    from/body_text. MMS replies arrive as "(no content)" with the text
    in a text_0.txt attachment -- the webhook drops those and the
    poller fetches the attachment.
  - Gateway domains recognized: vtext, vzwpix, txt.att, tmomail,
    sprintpcs, cricket, vmobl, google fi, metropcs, boost. GATEWAY_MAP
    ("+1nnn:domain+domain,...") blasts an outbound text at several
    carriers -- only the real one delivers.
  - Phone normalization: 10 digits -> +1nnn; a malformed "+4253..." will
    not match stored jobs.
  - Ambiguous webhooks require https; in dev use a tunnel, or skip it
    and let the poller do inbound.

TRIGGERS
--------

  client:      book -> 3 numbered slots -> pick -> Locked in + contractor
               told; reschedule -> pick -> moved + contractor told;
               cancel -> slot freed, rebook offer; eta -> stored ETA.
  contractor:  "running N late" -> shift + client ETA text; cancel ->
               client told + rebook offer; "what's my day" -> route digest.
  time:        reminders.js ticks every minute, texts the contractor
               REMINDER_LEAD_MINUTES (30) before a job; /internal/digest
               sends the morning route; /internal/client-update texts a
               job's client.

STATE
-----

bus/state.js persists customers, jobs, threads (pendingProposal,
pendingClarify, history capped at 8), dedup ids, and the action log to
STATE_FILE (default bus/.state.json, gitignored). The file format is
merged over defaults on load, so old state files never crash a new build.

ENV
---

AMBIG_API / AMBIGUOUS_API_KEY, AMBIGUOUS_BASE_URL, CONTRACT_PHONE,
CLIENT_PHONE, CONTRACTOR_TZ, MESSAGING_URL, PUBLIC_URL, UPSTREAM_URL,
BUS_URL, CALENDAR=memory, STATE_FILE, MAIL_POLL_SECONDS,
FANOUT_RETRY_MS/MAX, CALENDAR_SYNC_MS/DAYS, REMINDER_LEAD_MINUTES,
AI_CLASSIFY_TIMEOUT_MS, BLUEBUBBLES_URL/PASSWORD, CARRIER_GATEWAY,
GATEWAY_MAP. .env is gitignored -- never commit it.

TESTING
-------

  node --test '*/tests/*.test.js'

The glob matters: node --test <dir> does not discover all files. Tests
spin up real HTTP servers on ephemeral ports; sim transport +
stubCalendar mean the whole stack runs with no credentials. Write tests
for shared logic and the contracts above -- dedup, overlap, ordering,
payload shapes -- not for coverage points.
