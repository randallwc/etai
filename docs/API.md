API -- ETAi
===========

This document describes the working surface of the ETAi service: the inbound
webhooks it exposes, the tools the agent can call, the data model those tools
operate on, and how each operation maps onto the Ambiguous AI workspace API.
It is the contract the code is written against; keep it in sync when the
surface changes.

COMPONENTS
----------

agent service. TypeScript + Node. Owns the agent loop, the data model, and
every external call. Exposes the webhook endpoints below and calls out to
Ambiguous, the message channel, and (stretch) a voice provider.

channel adapter. Implemented by the phone team as a separate service behind
the two-endpoint contract in docs/PHONE.md (POST /webhooks/inbound to us,
POST /send to them); a console transport remains for dev. The agent only
ever sees a normalized message; transport detail stops at the boundary. See
docs/INTERFACES.md for component ownership.

ambiguous workspace. The system of record, wrapped by the calendar team's
service behind the contract in docs/CALENDAR.md. Calendar events, CRM
customer records, and task tickets live there. Base URL
https://app.ambiguous.ai, auth via an ak_ API key created in Admin -> API
keys. Three equivalent clients: the @ambiguous-ai/api-client package, the
`ambiguous` npm CLI, and raw REST. The CLI generates itself from the
workspace's live OpenAPI spec, so when a path is in doubt run
`npx ambiguous api GET /api/<path>` or fetch the spec rather than guessing.

voice provider (stretch). Vapi preferred -- its server-URL tool-call events
let the agent book mid-call. Bland is the fallback for a one-curl outbound
call.

DATA MODEL
----------

Defined in models/ as the first code commit (per AGENTS.md). Fields below are
the contract.

Contractor. id, name, trade, phone (E.164), ambiguousUserId, working hours,
home base address. One per workspace for the hackathon.

Customer. id, name (nullable -- learned over time), phone, address,
ambiguousCrmId, notes.

Job. id, customerId, contractorId, ambiguousEventId, status
(requested, confirmed, en_route, done, canceled), window {start, end},
address, description, source (message or call), eta.

Message. id, externalId (BlueBubbles GUID or provider SID, for dedup),
threadKey (counterparty phone / chatGuid), direction (in, out), body,
receivedAt.

AgentAction. id, tool name, args, result or error, createdAt. The audit log
that makes the demo legible and retry logic possible.

ENDPOINTS (agent service)
-------------------------

POST /webhooks/inbound
  Normalized inbound message receiver -- the full body shape, field
  semantics, and delivery rules are the contract in docs/PHONE.md. Dedup on
  externalId, return 202, hand to the agent loop asynchronously.
  Provider-specific webhooks (BlueBubbles events, Twilio form posts) are
  received by the phone service, never by us.

POST /webhooks/voice-toolcall
  Stretch. Synchronous tool invocation for mid-call agent actions (Vapi
  tool-calls events). Must answer within the provider's ~7.5s window, so
  resolve against the same tools as the message loop and reply inline with
  { "result": ... }.

POST /internal/digest
  Cron/manual trigger for the morning schedule text. Internal only.

GET /healthz
  Liveness; reports channel adapter and Ambiguous connectivity.

AGENT TOOLS
-----------

The LLM's function surface. Each tool is a thin wrapper; business rules live
in the agent loop, not the tools.

get_availability({ date, durationMinutes })
  -> Ambiguous calendar availability for the contractor's workspace member
     identity. Returns open windows inside working hours.

book_job({ customerId, start, end, description, address })
  -> Create Ambiguous calendar event, create/update CRM record, create Task
     ticket, set Job status confirmed. Then notify() both parties.

reschedule_job({ jobId, newStart, newEnd, reason })
  -> Update the event, then notify() the counterparty with the new window.

cancel_job({ jobId, reason })
  -> Cancel the event, set status canceled, notify() the counterparty, and
     offer rebooking in the same message.

get_schedule({ date })
  -> List the contractor's events for a day; source of the digest and of
     "what's my day" replies.

find_customer({ phone }) / upsert_customer({ phone, name?, address? })
  -> CRM lookup/create. Called on every inbound message from an unknown
     number before anything else.

notify({ phone, message })
  -> Channel adapter send. Never blocks on delivery -- iMessage has no
     delivery SLA.

report_delay({ minutes })
  -> Convenience composite: find current/next job, reschedule_job by the
     delta, notify() the affected client with the new ETA.

Stretch tools: get_weather({ date, zip }), get_travel_time({ from, to }),
place_call({ phone, task }), order_part({ jobId, description }).

MESSAGE FLOWS
-------------

Booking. inbound text -> find/upsert customer -> get_availability -> propose
one concrete slot (never a list of five) -> on yes, book_job -> confirmation
texts to client and contractor.

Late. inbound "running 20 late" -> report_delay(20) -> client texted new ETA;
contractor texted confirmation.

Cancel. inbound cancel -> cancel_job -> counterparty notified with rebook
offer.

Digest. /internal/digest -> get_schedule(today) -> single formatted text to
the contractor.

Outbound texts are short, plain, and signed as the contractor's business --
clients should never need to know software answered.

AMBIGUOUS MAPPING
-----------------

Auth: `ambiguous auth login --token ak_...` for the CLI, or the same token as
a bearer credential for the api-client and REST.

calendar       -> `ambiguous calendar ...` (events, RSVP, availability, .ics
                  export); availability example:
                  `ambiguous calendar availability --user-ids <id> --start
                  <iso> --end <iso> --json`
customers      -> `ambiguous crm ...`
job tickets    -> `ambiguous tasks ...`
notifications  -> `ambiguous notifications ...` and `ambiguous mail` /
                  `chat` for in-workspace delivery
inbound events -> `ambiguous webhooks ...` (register endpoints the workspace
                  pushes to -- useful if we want event-driven sync later)
escape hatch   -> `ambiguous api <METHOD> /api/<path> --data '<json>'` for
                  anything without a typed command; the live OpenAPI spec at
                  app.ambiguous.ai is the source of truth for exact paths

Verify before building: the calendar event path prefix, whether plain CRUD
consumes the 1,000 free monthly AI actions, and the MCP server URL (likely
per-workspace under app.ambiguous.ai).

CONFIG
------

AMBIGUOUS_API_KEY, AMBIGUOUS_WORKSPACE, CONTRACTOR_USER_ID -- the Ambiguous
side.

BLUEBUBBLES_URL, BLUEBUBBLES_PASSWORD -- primary channel. LOOPMESSAGE_* or
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM -- fallback channel.

OPENAI_API_KEY or ANTHROPIC_API_KEY -- the agent loop. VAPI_API_KEY /
VAPI_PHONE_NUMBER_ID / VAPI_ASSISTANT_ID or BLAND_API_KEY -- stretch voice.

PORT, PUBLIC_URL (the Cloudflare-tunnel or ngrok URL webhooks point at).

IDEMPOTENCY AND ERRORS
----------------------

Inbound messages are deduplicated on externalId before reaching the agent.
Every tool call is recorded as an AgentAction so a failed Ambiguous call can
be retried without re-prompting the user. Job status transitions are
validated (a canceled job cannot go en_route). The agent loop never throws at
the user -- tool failure becomes a plain-language "I couldn't reach the
calendar, try again in a minute" message and a logged action.

GOTCHAS
-------

BlueBubbles chatGuids look like `any;-;+15551234567` -- build them from the
counterparty phone, and key threads on the phone number not the raw guid.

BlueBubbles puts its password in the URL query string on sends; never log
request URLs.

LoopMessage sandbox cannot start conversations: the contact must text the
sender first, which opens a 24h reply window. Plan the demo order
accordingly.

Twilio trial prefixes every outbound text with "Sent from a Twilio trial
account -" and can only text verified numbers. Fine for a demo; do not
upgrade mid-event expecting 10DLC to clear.

The agent runs on inbound events only. There is no push channel to a UI --
if the stretch CopilotKit board is built, state updates require triggering a
run (AG-UI state is run-scoped, not broadcast).

COPILOTKIT (stretch only)
-------------------------

If a dispatcher board is wanted for the demo, CopilotKit v2 is the path:
CopilotRuntime with BuiltInAgent mounted in the same Node app, a React page
under a CopilotKit provider (no chat component), `useAgent` to render job
state and `useRenderTool` to render each tool call as a status card. Use
`/v2` subpath imports throughout -- most tutorials still show the deprecated
v1 API. Requires Node 20+ and one LLM key; no CopilotKit account needed.
Caveat above applies: state streams during runs, so each inbound message
that should update the board triggers a run server-side.
