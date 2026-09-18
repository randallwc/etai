THE SERVICE -- texts and calls in, replies out
==============================================

messaging/ is the whole backend: one Node process, no dependencies. A
text or voice turn comes in through a transport webhook (or the mail
poller), gets normalized and deduped, runs through the scheduling loop,
and the reply goes back out the same transport. There is no second
service and no HTTP hop between the phone layer and the brain.

Run it: `npm start` (node messaging/index.js, PORT default 4020).

MODULES
-------

  index.js      HTTP + wiring. createService(env, overrides) builds the
                transport, Ambiguous client, calendar, ai, store, loop,
                and tts; every piece is injectable for tests. Inbound
                messages enqueue per threadKey and run the loop
                in-process; a WORKING_BEAT_MS timer (default 1500) texts
                "On it - checking the schedule now." when a turn runs
                long.
  transports.js Outbound providers. Selection: bluebubbles (when
                BLUEBUBBLES_URL + BLUEBUBBLES_PASSWORD are set) ->
                ambimail (AMBIG_API) -> sim (stdout, sim-* ids).
  normalize.js  Provider payloads -> the normalized inbound shape:
                { channel, from, body, externalId, receivedAt,
                threadKey }. threadKey is the counterparty phone so
                threads stay stable across transports.
  mailpoller.js Polls the Ambiguous mail inbox for carrier-gateway SMS
                replies; see INBOUND VIA MAIL POLLING below.
  loop.js       The brain: normalized message -> intent -> calendar
                tools -> reply. Owns the business logic and the exact
                reply text. Per-thread pendingProposal state makes the
                two-phase booking flow work.
  ai.js         Intent classification via Ambiguous assistant/chat
                (models/intent.schema.json). A failed or unparseable
                response falls back to keyword classification, so the
                loop works without a key.
  prompts.js    Per-channel system prompts for classification (sms,
                imessage, voice).
  calendar.js   Calendar adapter: listDay, proposeSlots, createEvent,
                updateEvent, cancelEvent, sync, plus timezone helpers.
                With no Ambiguous key it returns an in-memory
                stubCalendar so tests exercise the same interface.
  state.js      createStore(file|null): threads, jobs, customers,
                dedup set, AgentAction tool log. file=null is memory-
                only for tests; a path persists to JSON on every
                mutation.
  reminders.js  Pre-job heads-up texts to the contractor inside
                REMINDER_LEAD_MINUTES of each job. Fires once per job.
  packet.js     Booking paperwork after a job lands: intake form,
                work-order doc, Sign draft, CRM deal, follow-up task.
  ambiguous.js  The ONLY file that fetches Ambiguous (backend mirror
                of the frontend src/api/ambiguous.js boundary rule).
  tts.js        Neural TTS for the call UI's spoken replies.

ENDPOINTS
---------

POST /send -- { to (E.164), body } -> 200 { externalId }. Outbound
bodies are branded "etAI update: <body>" here so every text is signed
uniformly.

POST /webhooks/bluebubbles, /webhooks/ambimail -- provider webhook
targets; payloads are normalized then accepted. Always 202.

POST /webhooks/inbound -- an already-normalized inbound message
(channel, from, body, externalId, receivedAt, threadKey). Dedups on
externalId, answers 202, processes async.

POST /webhooks/calendar -- a calendar notification ({ id, kind in
created|updated|deleted|reminder, summary or event.title, startAt }).
Dedups on "cal:"+id, answers 202, texts the contractor, triggers a
calendar sync.

POST /simulate/inbound -- { from, body, channel? } through the
identical normalize -> dedup -> loop path as a real text; the whole
service is exercisable without a phone.

POST /voice/turn -- { from (E.164), body, threadKey?, externalId? } ->
200 { reply }. The reply is returned in the body for the caller to
hear, NOT texted; notifications to the other party still go out as
texts. Per-thread queue waits for the real turn; a TURN_TIMEOUT_MS
timer (default 30s) only bounds the caller-facing reply, which becomes
"still working on it - I'll text you when it's done". Retries with the
same externalId get { reply:"", duplicate:true }.

POST /tts -- { text } -> audio/mpeg, or 503 when tts is not installed.

POST /internal/digest -- texts the contractor today's route.
POST /internal/client-update -- texts each client their next confirmed
booking plus a reschedule offer; optional { phone } scopes it.

GET /state -- { jobs, customers, actions } for the dispatch board.
GET /messages -- last 200 inbound, for debugging.
GET /healthz -- { ok, transport, stub, ambiguous, tts }.

INTENTS
-------

ai.js classifies into book, reschedule, cancel, running_late,
day_summary, other. The loop then:

  book        -> proposeSlots offers up to 3 numbered open times; the
                 reply picks by number, ordinal, or clock time. Books
                 the event, builds the job packet, replies "Locked in",
                 texts the contractor.
  reschedule  -> same proposal flow; updateEvent moves the event.
  cancel      -> cancelEvent; the other party is told the slot is free.
  running_late-> updateEvent shifts the next job by delayMinutes; the
                 client gets the new ETA.
  day_summary -> listDay formatted as a route line.
  other       -> contractor's message becomes an Ambiguous task; a
                 client gets a short help text.

Working hours are 9-17 with 90-minute spacing; jobs default to 60
minutes. Client-originated changes always notify the contractor;
contractor-originated changes notify the affected client.

ENV
---

  PORT                  listen port (default 4020)
  AMBIG_API             Ambiguous ak_ key; unset -> stub calendar,
                        sim-friendly behavior
  AMBIGUOUS_BASE_URL    defaults to https://app.ambiguous.ai
  CONTRACT_PHONE        contractor's E.164 number: identifies the boss,
                        digest and reminder target
  CONTRACTOR_TZ         IANA tz for slot math (default
                        America/Los_Angeles)
  STATE_FILE            JSON persistence path (default
                        messaging/.state.json at startup)
  BLUEBUBBLES_URL       Cloudflare tunnel URL of the BlueBubbles server
  BLUEBUBBLES_PASSWORD  its API password
  CARRIER_GATEWAY       fallback gateway domain (default vtext.com)
  GATEWAY_MAP           per-recipient carrier overrides, see below
  ALLOWED_FROM          comma-separated E.164 senders to accept; empty
                        accepts everyone
  WORKING_BEAT_MS       delay before the "On it" text (default 1500)
  TURN_TIMEOUT_MS       voice-turn caller-facing timeout (default 30000)
  REMINDER_LEAD_MINUTES pre-job heads-up window (default 30)
  REMINDER_WINDOW_HOURS remote reminder poll lookahead (default 24)
  REMINDER_POLL_MS      remote reminder poll interval (default 60000)
  CALENDAR_SYNC_MS      calendar mirror sync interval (default 30000)
  MAIL_POLL_SECONDS     inbox poll interval (default 15; 0 disables)
  MAIL_POLL_LIMIT       inbox page size per poll (default 20)
  FETCH_TIMEOUT_MS      ceiling on outbound fetches (default 8000,
                        transport sends 15000)

The entry point loads repo-root .env via shared/env.js (never
overrides vars already set). No public URL is needed for the service
itself -- only provider webhooks need a reachable address.

CARRIER GATEWAYS -- per-recipient ambimail routing
--------------------------------------------------

ambimail delivers by mailing <digits>@<gateway>. A carrier gateway only
delivers to its own subscribers: send an AT&T number to vtext.com and
Verizon accepts the mail, drops the SMS, and reports nothing -- the
/send caller gets a 200 with a real externalId and no error exists on
any side. The demo hit exactly this once (AT&T gateway, Verizon phone,
silence). The only fix is routing each known number to the right
domain.

GATEWAY_MAP is comma-separated num:domain[+domain...] entries keyed on
the 10-digit number, and every listed domain is sent -- only the real
carrier delivers, the rest are silent drops that cost nothing. Pin a
known handset to one domain (5550100100:vtext.com for the Verizon demo
phone, 5550100101:txt.att.net for the AT&T one); blast unknowns with a
domain per likely carrier. Malformed entries are ignored, never a
crash. Numbers not in the map fall back to CARRIER_GATEWAY.

INBOUND VIA MAIL POLLING
------------------------

When a client replies to an ambimail text, the carrier gateway turns
the SMS into an email that lands in the Ambiguous workspace mail inbox,
sent from the number's gateway address (e.g. 5550100100@vzwpix.com).
The mailpoller closes that loop: whenever AMBIG_API (or
AMBIGUOUS_API_KEY) is set it polls GET /api/mail/inbox?unread=true
every MAIL_POLL_SECONDS, turns each unread item into a normalized
inbound message, and feeds it through the same dedup -> loop path as
the webhook transports.

Phone derivation only accepts sender (or Reply-To) addresses on known
carrier gateway domains -- vtext.com, vzwpix.com, vmobl.com,
txt.att.net, messaging.sprintpcs.com, tmomail.net, and friends, plus
whatever CARRIER_GATEWAY names. A ten-digit local part becomes
+1<number>. Mail from ordinary addresses is logged once, skipped, and
marked read. Skipped ids are remembered in memory (capped at 5000) so
a failed mark-read does not re-log the same mail.

The body is the first non-quoted block of body_text: lines starting
with ">", an "On ... wrote:" header, separator runs, or "Sent from my
..." terminate the reply. Consumed items are acked with PATCH
/api/mail/{id} {read:true}, and dedup keys on externalId
"ambmail-<email uuid>". Polls are serialized: a poll that outlasts
MAIL_POLL_SECONDS short-circuits the overlapping tick.

Caveats: this only sees replies to ambimail texts; a client texting a
fresh number reaches nothing. Latency is up to one poll interval plus
the carrier's email-to-SMS hop. Channel is "sms", not "imessage".

TESTING WITHOUT A PHONE
-----------------------

Run the service, POST /simulate/inbound, watch the sim transport log
replies to stdout. The smoke suite (messaging/tests/smoke.test.js,
`npm test`) covers the same path with an in-memory calendar and fake
transport.

Real iMessage needs a Mac signed into iMessage with the BlueBubbles
server: enable its Cloudflare tunnel, point its webhook at
/webhooks/bluebubbles, export BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD.

GOTCHAS
-------

Dedup is on externalId and in-memory -- a restart re-accepts the same
id once. Providers retry, so a persisted dedup or idempotent loop is
the upgrade path if that matters.

POST bodies are capped at 1 MiB; over that the service drains the
upload and replies 413. Malformed JSON gets 400.

BlueBubbles echoes our own sends as new-message events with
isFromMe=true; they are filtered before the loop or the agent answers
itself. BlueBubbles takes its password in the URL query string; never
log outbound request URLs.

Ambiguous availability is member-centric: busy slots exist only for
the contractor's workspace user. Client calendars are never consulted.

Late and cancel flows text the client only for jobs booked through the
agent (the job record links the event id to the customer's phone).
Events created elsewhere have no client phone, so the contractor still
gets confirmation but no client text goes out.

Tool failures never reach the user as errors: the loop replies
"couldn't reach the calendar, try again in a minute" and the failed
call is logged in the action log.

CRM sync is best-effort: a booking upserts the client into the
workspace CRM via ambi.upsertContact inside the recorded action;
failure is swallowed and the booking still completes.
