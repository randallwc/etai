GOAL -- ETAi
============

ETAi is a scheduling agent for blue-collar contractors that lives entirely in
iMessage and phone calls. There is no app, no dashboard, and no chat window.
The contractor and their clients talk to the agent the way they already talk to
everyone else; the agent does its work through tools and shows the results on a
shared calendar.

PROBLEM
-------

Independent tradespeople -- gardeners, plumbers, cleaners, handymen -- run the
business from a phone, usually with dirty hands and a truck between them and a
desk. Scheduling is a pile of texts and voicemails: clients ask "can you come
Thursday?", jobs slide, nobody hears that the tech is running late, and the
day's plan lives in someone's head. Field-service software (Jobber, Housecall
Pro, ServiceTitan) assumes both sides adopt an app and a portal. Clients never
do. The failure is not features; it is the interface.

FIVE WHYS
---------

Why does etAI exist? A trade worker cannot run a schedule while doing the
work. Every booking, reschedule, and "where are you" text competes with
the job in their hands, and the phone is the thing they have to ignore to
do the job at all.

Why is that a problem? Scheduling chaos. Double-bookings, dead gaps
between jobs, clients who never hear an ETA and call mid-job to ask. The
day gets planned in someone's head or between jobs, and it falls apart
the moment anything shifts.

Why doesn't existing software fix it? Dispatch tools assume an office
with a dispatcher running them, and they assume clients adopt a portal.
A solo worker is the back office; they do not have time to operate the
tool that is supposed to save them time, their clients never install the
app, and hiring a human dispatcher does not pencil out for a one-truck
operation.

Why an agent over text instead of a better app? Because the interface
has to cost zero effort on both sides. Texting is what the worker and
the client already do. An agent that understands freeform texts,
negotiates slots against a real calendar, and writes the booking removes
the work instead of moving it into a dashboard. A form or a rules-based
bot breaks the first time a client sends "can you come Thursday after 3,
gate code is 4412".

Why does that matter enough to build? Time is the trade worker's real
inventory. Less scheduling overhead means more jobs per day, which means
more clients, which means more money. The coordination layer has always
been priced for companies with staff; etAI delivers it for the cost of a
text thread.

PRODUCT
-------

ETAi is a dispatcher you text. The agent owns the contractor's calendar, talks
to clients on the contractor's behalf, and keeps everyone informed. It maps to
the hackathon premise directly: the most useful agents show up inside the tools
people already have. Our agent shows up in Messages and the phone -- the two
apps every contractor and every client already use.

The calendar of record is Ambiguous AI's workspace calendar, chosen because it
is genuinely agent-first: every feature has a human UI and an agent endpoint,
access is via REST API, an npm CLI, a typed TypeScript client, and an MCP
server. The human-facing Ambiguous calendar UI doubles as our demo visual --
the agent has no UI of its own, but judges can watch its tool calls land on a
real calendar in real time.

TENETS
------

  - no chat -- the product surface is the phone, not a window
  - ai uses tools -- the agent acts through the Ambiguous API, it does
    not just talk
  - solves a problem non-technical people actually have

USERS
-----

CONTRACTOR (the pro). Owns the schedule. Texts the agent to see the day, report
delays, block time, and approve bookings. Reaches the agent by iMessage; calls
are a stretch channel.

CLIENT (the customer). A homeowner who texts the agent's number to book,
reschedule, or ask when the pro arrives. The client never installs anything and
never knows the counterparty is software.

WHAT THE AGENT DOES (MVP)
-------------------------

DAILY DIGEST. Each morning the agent texts the contractor the day's schedule:
jobs, times, addresses, notes. This is the hook -- the agent is useful before
anyone asks it anything.

BOOKING. A client texts "need a sprinkler repair Thursday afternoon". The agent
identifies or creates the customer record, checks the contractor's availability,
proposes a slot, and on confirmation creates the calendar event and confirms
both parties.

RUNNING LATE. The contractor texts "running 20 late". The agent finds the
current or next job, shifts the event, and texts the affected client a new ETA.

CANCEL AND RESCHEDULE. Either party can cancel or move a job by text. The agent
updates the event, notifies the other party, and offers a rebook when a job is
canceled.

ARCHITECTURE
------------

SYSTEM OF RECORD. An Ambiguous AI workspace. The contractor is a workspace
member; the agent is a provisioned agent identity. Calendar events, customer
records (Ambiguous CRM), and job tickets (Ambiguous Tasks) all live in one API
at https://app.ambiguous.ai behind an ak_ API key. See API.md for the surface.

CHANNEL. iMessage via a BlueBubbles server running on a Mac signed into
iMessage. BlueBubbles exposes REST for sending and webhooks for receiving, and
ships a built-in Cloudflare tunnel so the Mac does not need public networking.
If no Mac is available at the venue, the fallback ladder is LoopMessage's free
sandbox (two-way iMessage for up to 5 contacts, inbound-initiated), then Twilio
SMS, then a console simulator. The channel is an adapter; the agent never sees
which transport carried a message.

BRAIN. A TypeScript + Node service. Inbound webhook -> intent -> LLM tool calls
-> outbound message. One agent loop, no framework ceremony. Tools wrap the
Ambiguous API and the channel adapter.

NO UI. The product surface is the phone. CopilotKit is documented in API.md as
an optional stretch demo board (live job-status cards driven by agent state),
but nothing in the MVP depends on it.

RELIABILITY -- ALWAYS LISTENING
-------------------------------

The product dies the first time a client's text gets no answer, so the system
is built around concurrent listener loops rather than one-shot request
handling. Node's event loop runs all of them in parallel; no worker threads
are needed because every wait is I/O.

Listeners that must never stop:

  - bus subscription: the bus POSTs its /webhooks/inbound URL to the
    messaging service at boot and re-subscribes every 30 seconds forever.
    A messaging restart wipes its subscriber set; the resubscribe loop is
    what heals it.
  - fanout retry buffer: when an inbound message reaches messaging with no
    live subscriber, it is queued and re-fanned every FANOUT_RETRY_MS
    (5s) up to FANOUT_RETRY_MAX (24) times instead of being dropped. This
    closes the resubscribe gap -- a BlueBubbles text arriving while the bus
    is down is delivered once the bus comes back, not lost.
  - mail poller: Ambiguous inbox polling retries unread mail indefinitely;
    a mail item is only marked read after a subscriber accepts it.
  - turn serialization: inbound messages are processed through a promise
    chain so two texts on one thread can never race (book + slot pick can
    no longer interleave into a double booking).
  - dedup: externalId is the dedup key at both layers. The same mail seen
    by webhook and poller, or a webhook redelivery, collapses to one turn.

Known failure modes these cover: messaging restart with in-flight inbound,
bus restart, Ambiguous slowness (all Ambiguous fetches are bounded at 60s;
intent classification races a 15s timeout and falls back to keywords),
and duplicate webhook delivery.

IN-MEMORY CALENDAR
------------------

The bus keeps a local mirror of the Ambiguous calendar (bus/calendar.js).
Every loop decision -- proposing slots, listing a day, checking for
conflicts and duplicate bookings, create, reschedule, cancel -- reads and
writes memory only, so replies never wait on the network. sync() drains
queued writes to Ambiguous in one batch, then pulls remote events in
14-day windows over a rolling 45-day horizon and merges them. Remote
deletes are tombstoned out of memory. The server syncs at boot and every
CALENDAR_SYNC_MS (30s), and inbound calendar webhooks trigger a sync.
Local event ids stay stable for callers; remoteIds translate at push time.
CALENDAR=memory forces the bare in-memory store with zero API calls, which
is how the whole stack runs offline.

SUBAGENTS -- WORKSTREAM SPLIT
-----------------------------

The repo is built by many agents in parallel. Each owns its files
exclusively; two agents never edit the same file. Full role contracts live
in AGENTS.md section 5; this is the current roster:

  - Messaging / Phone Agent -- messaging/: transports, normalization,
    fanout, dedup, the retry buffer, mail polling.
  - Agent Core Agent -- bus/: the loop, intent handling, thread state,
    replies.
  - Calendar Sync Agent -- bus/calendar.js: the in-memory mirror, batch
    push/pull, conflict and free-slot checks.
  - NLP / Intent Agent -- bus/ai.js + bus/prompts.js: classify prompt,
    context lines, keyword fallback, classify timeout.
  - Notifications Agent -- bus/reminders.js + calendar webhook: reminder
    texts, contractor alerts on calendar changes, ETA texts.
  - CRM / Tasks Agent -- bus/ambiguous.js CRM surface: contact upsert,
    task creation, never blocking a reply.
  - Frontend UI Agent -- frontend/src/components + styles.css: dispatcher
    board, job detail, call overlay.
  - Persona / Conversation Agent -- agents.js, parseRequest.js, CallScreen
    dialogue flow.
  - Integration Agent -- frontend/src/api/ambiguous.js, schedule.js:
    browser-side Ambiguous boundary and slot math.
  - Media / Voice Agent -- AgentSurface, mic/STT/TTS, /voice/turn caller.
  - Voice Telephony Agent -- Vapi/Bland wiring when calls land.
  - Sim / Demo Agent -- scripts/chat.js, sim transport, demo drivers: a
    fake phone that runs the whole loop with no providers.
  - Seed / Fixture Agent -- scripts/seed-*.js: calendar fixtures for demos
    and load testing.
  - Test / E2E Agent -- bus/tests/integration.test.js, sms.test.js:
    fake-Ambiguous + fake-phone end-to-end coverage.
  - Docs Agent -- docs/*: keeps prose docs honest after merges and rewrites.
  - Devops / Serve Agent -- serve.sh, watchdogs, tunnel setup, env files.

WHY THIS BUILD
--------------

The hackathon brief asks for an agent that shows up where people already
work. The trades are the sharpest version of that brief: the work happens
in trucks and crawl spaces, the coordination already happens in a text
thread, and every existing tool tries to pull both into software nobody
asked for.

The build follows the ponytail rule from AGENTS.md - the best code is the
code never written, and every choice stops at the first rung that holds:

  - No app. The product surface is a phone number. Zero install for
    clients, zero onboarding for the contractor.
  - No new platform. Ambiguous already provides calendar, CRM, tasks, and
    mail behind one API key, so the system of record is a dependency
    instead of a build.
  - No framework ceremony. The bus is one agent loop - inbound text,
    classify, tool call, reply - in plain Node with zero-dep shared
    helpers.
  - No delivery infrastructure. ambimail turns Ambiguous mail into SMS
    through the carrier gateway. The messaging service stays an adapter
    so BlueBubbles, Twilio, or the simulator carry the same messages.
  - One boundary per integration. One file fetches Ambiguous in the bus,
    one in the frontend. Stub fallbacks keep every flow testable offline.

The result is small enough to demo end-to-end and honest about its
ceilings: carrier routing is a JSON map, slot finding is a linear scan,
intent classification falls back to regex when the model is unavailable.
Each simplification is named in the docs with its upgrade path - you may
simplify, but you never hide the seam.

SCOPE
-----

MVP
  - calendar: create, cancel, update (Ambiguous)
  - notifications: running-late, cancellation, daily digest
  - messages: two-way iMessage (BlueBubbles) with documented fallbacks

STRETCH, in rough priority order
  - weather: rain-aware rescheduling for outdoor trades -- the highest-value
    stretch, since a gardener's schedule is weather-bound
  - maps and travel time: real ETAs between jobs instead of "on my way"
  - phone calls: Vapi preferred (mid-call tool calls let the agent book while
    talking); Bland is the one-curl fallback
  - parts ordering: contractor asks the agent to order a part; agent blocks the
    return visit on the calendar
  - prioritization: emergency jobs (burst pipe) bump flexible ones (lawn)
  - dispatcher board: CopilotKit useAgent + useRenderTool cards for the demo

OUT OF SCOPE
  - payments, quotes, invoicing
  - multi-contractor routing or dispatch optimization
  - any client-facing app or portal

RISKS AND GOTCHAS
-----------------

IMESSAGE NEEDS A MAC. Every real iMessage path requires a Mac signed into an
Apple ID with Full Disk Access and Accessibility permissions. BlueBubbles setup
is 30-60 minutes and must happen before or at the very start of the event. If
no Mac exists, do not fight it: LoopMessage sandbox (free, but a contact must
text the sender first, then a 24h reply window) or Twilio SMS (verified numbers
only on trial, outbound prefixed "Sent from a Twilio trial account").

AMBIGUOUS IS YOUNG. The API is real but docs are thin. Budget ten minutes to
introspect the live OpenAPI spec (the CLI builds itself from it) rather than
trusting indexed documentation. Confirm whether ordinary CRUD calls consume the
free tier's 1,000 monthly "AI actions" and whether provisioned agents count
against the 5-seat cap.

AVAILABILITY IS MEMBER-CENTRIC. Ambiguous checks free/busy across workspace
members. Clients are not members -- availability is computed only over the
contractor's calendar, and client-facing times are just event times. Do not
design anything that needs free/busy lookups on a client's calendar.

NO GOOGLE SYNC. The Ambiguous calendar is standalone with one-way .ics export.
Events the agent creates live in Ambiguous; if a demo needs them on a personal
Google Calendar, export is the path.

TWILIO 10DLC IS A TRAP. US A2P registration takes days and upgrading does not
bypass it. Trial verified numbers are the only viable Twilio path same-day.

CONSIDERED AND REJECTED
-----------------------

Beeper self-hosted Matrix bridge: needs a homeserver, a Mac or jailbroken
iPhone as registration provider, and a relay. Too much for four hours.

AirMessage: custom WebSocket protocol for its own clients, no general REST or
webhook surface. BlueBubbles is strictly better for arbitrary backends.

AppleScript Messages.app automation: send-only is a few lines, but receiving
means polling ~/Library/Messages/chat.db with dedup logic, and the JXA bridge
is broken on macOS Tahoe. BlueBubbles solves both directions already.

CopilotKit Channels for messaging: no shipped SMS/iMessage adapter; the
WhatsApp adapter needs Meta app credentials. We talk to BlueBubbles/Twilio
directly.

DIY Twilio Media Streams + OpenAI Realtime for voice: 1-2 hours of audio
plumbing for what Vapi or Bland do with one POST.

Cal.com / Nylas / Chronary instead of Ambiguous: reasonable scheduling
primitives, but the brief names Ambiguous and it is a hackathon sponsor; its
workspace also gives us CRM, tasks, and mail on one API.

DEMO (4 minutes)
----------------

  1. Contractor's phone: text "what's my day" -- agent reads the Ambiguous
     calendar and replies with the route.
  2. Client's phone: text the agent to book a Thursday job -- agent proposes a
     slot; on "yes" the event appears live in the Ambiguous web UI.
  3. Contractor texts "running 20 late" -- client gets a new ETA text; event
     visibly shifts on screen.
  4. Client cancels by text -- event is canceled and the contractor is offered
     the freed slot for a waitlist job.

Every line of the demo happens in Messages; the Ambiguous calendar on the
projector is the proof the tools actually ran.
