BEHAVIORS -- what the deleted tests used to pin down
====================================================

The test suite was cut to smoke tests (messaging/tests/smoke.test.js
plus the frontend vitest files). This file records the behaviors the
removed tests verified, so a regression here is noticed in review
rather than rediscovered in production. Grouped by area; the code is
the source of truth if this and the implementation disagree.

Booking flow (messaging/loop.js)
--------------------------------

- Two-phase per thread: a book intent offers up to 3 numbered open
  slots and stores a pendingProposal; the next message picks by
  number ("1"), ordinal ("second"), or clock time ("9am works").
- Missing fields are asked for one at a time: no day or time pref ->
  "what day or time works"; no location -> "the address".
- Stale proposals expire on PROPOSAL_TTL_MS so an old offer cannot be
  consumed by an unrelated new message; proposals whose slots are all
  in the past are dropped.
- findSlots floors at now+15min; working hours 9-17, 90-minute
  spacing, 60-minute default duration, contractor timezone.
- A confirmed pick creates the event, runs the job packet, replies
  "Locked in" plus the intake-form link, and texts the contractor.

Other intents
-------------

- reschedule reuses the proposal flow; on pick, updateEvent moves the
  existing event and the counterparty is notified.
- cancel cancels the event, tells the other party the slot is free,
  and offers rebooking.
- running_late shifts the next confirmed job by delayMinutes and texts
  the affected client the new ETA.
- day_summary formats the contractor's day as a route line.
- other: a contractor message becomes an Ambiguous task; a client gets
  a short help text.
- Late and cancel client texts only go out for agent-booked jobs
  (the job record links event id to client phone).

State and classification
------------------------

- dedup on externalId is in-memory and synchronous; calendar
  notifications use "cal:"+id, mail replies "ambmail-<uuid>"; a
  restart re-accepts once.
- ai.js extracts a JSON intent from assistant/chat with a tolerant
  parser and falls back to keyword classification on failure or a
  missing key.
- prompts.js renders per-channel classify prompts (sms, imessage,
  voice); unknown channels get the sms profile.
- Customer names are learned from intent.name and re-parsed message
  fields; the CRM upsert is best-effort, stores ambiguousCrmId, and
  skips resync once set.
- store persists to STATE_FILE on every mutation when a path is set;
  null path is memory-only.
- packet.js steps are each non-fatal; failures collect in
  packet.errors and the packet is stored on the job for GET /state.

Concurrency
-----------

- Turns enqueue per threadKey so two texts on one thread process in
  arrival order; different threads interleave freely.
- /voice/turn returns the reply in the body (never texts the caller)
  and shares thread state with SMS, so a slot offered by voice can be
  confirmed by text. TURN_TIMEOUT_MS bounds only the caller-facing
  reply; the queued turn still completes and its texts go out.
- The 1.5s "On it" working beat is canceled when the real reply
  lands.

Transports and normalization
----------------------------

- BlueBubbles events with isFromMe=true are filtered before the loop
  or the agent answers itself; dedup keys on the message guid.
- ambimail sends POST /api/mail/send to <number>@<gateway>;
  GATEWAY_MAP routes each known 10-digit number to its carrier's
  domain (a wrong gateway silently delivers nothing).
- The mail poller only accepts senders on known carrier gateway
  domains; other mail is logged once, marked read, and skipped.
  Reply bodies are cut at quoted lines, "On ... wrote:" headers,
  separators, and "Sent from my ...".
- /send brands bodies "etAI update: <body>" and passes through bodies
  already carrying the prefix.

Frontend
--------

- CallScreen phases: connecting -> live -> sending -> done, with
  re-dial resetting to connecting.
- A "Is that all" agent message plus a done-signal reply (yes/no/
  that's all/all set/bye and friends) ends the call and hands the
  transcript to sendConversation.
- When the service is unreachable the agent says so instead of
  answering locally; there is no in-browser scheduling fallback.
- fetchCalendarJobs returns null without an API key; sendConversation
  returns { ok:false } on failure instead of throwing.
