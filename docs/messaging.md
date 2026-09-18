THE SERVICE -- texts and calls in, replies out
==============================================

messaging/ is the whole backend: one Node process, no dependencies. A
text or voice turn arrives through a transport webhook or the mail
poller, is normalized and deduped, runs through the scheduling loop
in-process, and the reply leaves by the same transport. Run it:
`npm start` (PORT default 4020).

MODULES
-------

  index.js      HTTP + wiring. createService(env, overrides) builds
                everything injectable for tests. Turns enqueue per
                threadKey; WORKING_BEAT_MS (1500) texts "On it" when a
                turn runs long.
  loop.js       The brain: message -> intent -> calendar tools ->
                reply. Owns business logic and reply text; per-thread
                pendingProposal makes the two-phase booking work.
  ai.js         assistant/chat intent classification
                (models/intent.schema.json); falls back to keywords on
                failure or no key. prompts.js holds the per-channel
                prompts.
  calendar.js   listDay, proposeSlots, createEvent, updateEvent,
                cancelEvent, sync, tz helpers; in-memory stubCalendar
                with no key.
  state.js      threads, jobs, customers, dedup set, action log;
                persists to STATE_FILE per mutation, memory-only when
                null.
  transports.js outbound providers: bluebubbles -> ambimail -> sim.
  normalize.js  provider payloads -> { channel, from, body,
                externalId, receivedAt, threadKey }; threadKey is the
                counterparty phone.
  mailpoller.js Ambiguous inbox poll for carrier-gateway SMS replies.
  reminders.js  pre-job heads-up texts to the contractor inside
                REMINDER_LEAD_MINUTES.
  packet.js     booking paperwork: intake form, work order, Sign
                draft, CRM deal, follow-up task.
  ambiguous.js  THE backend Ambiguous boundary - only file that
                fetches it (frontend twin: src/api/ambiguous.js).
  tts.js        neural TTS for the call UI.

ENDPOINTS
---------

  POST /send                 { to E.164, body } -> { externalId };
                             brands bodies "etAI update: <body>"
  POST /webhooks/bluebubbles provider events -> normalize -> accept
  POST /webhooks/ambimail    same, plus event.* -> calendar notify
  POST /webhooks/inbound     normalized message -> dedup -> 202 -> loop
  POST /webhooks/calendar    { id, kind, summary|event.title, startAt }
                             -> dedup "cal:"+id -> text contractor ->
                             calendar sync
  POST /simulate/inbound     { from, body } through the real path
  POST /voice/turn           { from, body, threadKey?, externalId? } ->
                             { reply }; reply returned in body, never
                             texted; TURN_TIMEOUT_MS (30s) bounds only
                             the caller-facing reply ("still working on
                             it - I'll text you when it's done"), the
                             queued turn still completes
  POST /tts                  { text } -> audio/mpeg, 503 w/o dep
  POST /internal/digest      texts contractor today's route
  POST /internal/client-update  texts clients their next booking;
                             optional { phone } scopes it
  GET  /state                { jobs, customers, actions } for the board
  GET  /messages             last 200 inbound
  GET  /healthz              { ok, transport, stub, ambiguous, tts }

INTENTS
-------

book -> offer up to 3 numbered slots; reply picks by number, ordinal,
or time; book event, run packet, "Locked in" + form link, text
contractor. reschedule -> same flow, updateEvent. cancel ->
cancelEvent, tell the other party, offer rebook. running_late ->
shift next job by delayMinutes, text client new ETA. day_summary ->
route line. other -> contractor text becomes a task; client gets help
text. Working hours 9-17, 90-minute spacing, 60-minute default.
Client changes notify the contractor; contractor changes notify the
affected client.

ENV
---

  PORT 4020 . STATE_FILE . CONTRACT_PHONE (the boss, digest + reminder
  target) . CONTRACTOR_PHONE alias . CONTRACTOR_TZ (default
  America/Los_Angeles)
  AMBIG_API or AMBIGUOUS_API_KEY (unset -> stub calendar) .
  AMBIGUOUS_BASE_URL
  BLUEBUBBLES_URL . BLUEBUBBLES_PASSWORD
  CARRIER_GATEWAY (default vtext.com) . GATEWAY_MAP (see below)
  ALLOWED_FROM (E.164 allowlist; empty accepts all)
  WORKING_BEAT_MS 1500 . TURN_TIMEOUT_MS 30000
  REMINDER_LEAD_MINUTES 30 . REMINDER_WINDOW_HOURS 24 .
  REMINDER_POLL_MS 60000 . CALENDAR_SYNC_MS 30000 . CALENDAR_SYNC_DAYS 45
  AI_CLASSIFY_TIMEOUT_MS 15000 . MAIL_POLL_SECONDS 15 . MAIL_POLL_LIMIT 20
  FETCH_TIMEOUT_MS 8000 . TTS_VOICE . CALENDAR=memory forces the stub

Repo-root .env loads via shared/env.js at startup (never overrides set
vars). No public URL needed unless registering provider webhooks.

REMINDERS
---------

Two overlapping paths, both contractor-only: reminders.js watches the
job store for agent-booked jobs; pollRemoteReminders() polls Ambiguous
GET /calendars/upcoming-reminders?window_hours= every REMINDER_POLL_MS
for events made elsewhere (that feed only covers events that HAVE
reminders). POST /webhooks/calendar is the push variant once the
service has a public URL. Dedup "cal:"+id means a restart re-delivers
a still-due reminder once.

CARRIER GATEWAYS
----------------

ambimail delivers by mailing <digits>@<gateway>. A gateway only
delivers to its own carrier's subscribers: AT&T number to vtext.com is
accepted, silently dropped, and /send still returns 200. No error
exists on any side -- the demo hit exactly this. GATEWAY_MAP is
num:domain[+domain...] keyed on the 10-digit number; every listed
domain is sent and only the real carrier delivers. Pin known numbers
to one domain; numbers not in the map fall back to CARRIER_GATEWAY.

MAIL POLLING
------------

A client replying to an ambimail text lands in the Ambiguous mail
inbox as an email from <number>@<gateway>. The poller reads
GET /api/mail/inbox?unread=true every MAIL_POLL_SECONDS, accepts only
senders on known gateway domains (ten-digit local part -> +1<number>),
cuts the body at quoted/"On ... wrote:"/"Sent from my" lines, feeds it
through the same accept() path, then marks it read. Other mail is
logged once, marked read, skipped (cap 5000 remembered ids). Dedup key
"ambmail-<uuid>" collapses mail arriving via both poll and
/webhooks/ambimail push. Caveats: only replies to ambimail texts
arrive; latency is one poll interval plus the carrier hop; channel is
"sms" not "imessage"; polls serialize rather than stack.

CONCURRENCY
-----------

Turns serialize per threadKey ("book" then "1" process in order);
threads interleave freely. Dedup claims are synchronous and atomic.
The calendar rejects overlapping confirmed events ({code:"conflict"})
as the backstop. Mail batches and calendar pushes run in parallel;
Ambiguous calls are bounded and classify falls back to keywords.
Dedup is in-memory, so a restart re-accepts a redelivered message
once. New entry points go through enqueue(), never loop.handle
directly.

TESTING
-------

`npm test` runs the smoke suite (in-memory calendar, fake transport)
covering book, dedup, /send, /voice/turn, calendar notify, healthz.
Live check without a phone: run the service, POST /simulate/inbound,
watch the sim transport log replies. Real iMessage needs a Mac with
BlueBubbles: enable its tunnel, point its webhook at
/webhooks/bluebubbles, export BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD.

GOTCHAS
-------

- BlueBubbles echoes our sends with isFromMe=true; filtered or the
  agent answers itself. Its password rides in the URL query -- never
  log outbound URLs.
- Bodies capped at 1 MiB -> 413; malformed JSON -> 400.
- Availability is member-centric: only the contractor's workspace user
  has busy slots; client calendars are never consulted.
- Late/cancel texts reach the client only for agent-booked jobs (the
  job record links event id to client phone).
- Tool failures never surface as errors: the loop replies "couldn't
  reach the calendar, try again in a minute" and logs the action.
- CRM upsert is best-effort; failure is swallowed, booking completes.
