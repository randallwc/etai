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
