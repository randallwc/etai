AGENT -- the scheduling brain
=============================

agent/ is the service that answers texts. Messaging delivers normalized
inbound messages to it; it decides what the sender wants, calls Ambiguous,
and replies through messaging's /send. There is no UI and no chat state
beyond a pending booking confirmation per thread.

WIRING
------

On start it POSTs {MESSAGING_URL}/subscriptions with
{PUBLIC_URL}/webhooks/inbound so every inbound text lands here. If
MESSAGING_URL is unset, replies are logged and collected in memory instead
of sent -- that is how tests and offline demos run.

ENDPOINTS
---------

POST /webhooks/inbound -- the normalized message shape from
models/phone-contract.schema.json. Dedups on externalId, answers 202, then
processes async.

POST /internal/digest -- sends the contractor the day's schedule (uses
CONTRACT_PHONE). Wire to a cron or hit it manually in the demo.

GET /healthz -- { ok, stub, messaging }.

INTENTS
-------

The router is agent/intent.js -- deterministic keyword matching, no LLM,
with a clean seam to swap one in later. Recognized today:

  "what's my day" / "tomorrow's schedule" -> lists the day's events
  "running 20 late" / "running late"      -> shifts the next job, says it
                                           will tell the client
  "cancel"                                -> cancels the next job today
  "need X Thursday", "book", "tomorrow afternoon" -> checks availability,
                                           proposes the first open slot
  "yes" / "confirm"                       -> books the proposed slot
  "no"                                    -> drops the proposal, asks when
  anything else                           -> a short help text

Working hours are 9-17, jobs default to 60 minutes; both are constants in
index.js -- hackathon-simple.

ENV
---

  PORT                listen port (default 4030)
  MESSAGING_URL       messaging service base URL (send + subscribe)
  PUBLIC_URL          this service's reachable URL for the subscription
  AMBIG_API           Ambiguous ak_ key; unset -> stub calendar in memory
  AMBIGUOUS_BASE_URL  defaults to https://app.ambiguous.ai
  CONTRACTOR_USER_ID  Ambiguous user id used for availability + attendees
  CONTRACT_PHONE      contractor's number, used by the digest

The entry point loads repo-root .env via shared/env.js.

GOTCHAS
-------

State persists to `agent/.state.json` (gitignored) on every mutation:
pending bookings, dedup ids, customers, jobs, and the AgentAction-style
tool log. Restart mid-demo keeps half-finished bookings. The stub
calendar's events stay in-memory.

Ambiguous availability is member-centric: it answers busy slots for the
contractor's workspace user only. Client calendars are never consulted.

Late and cancel flows text the client only when the event was booked
through the agent (the job record links the Ambiguous event id to the
customer's phone). Events created elsewhere have no client phone, so no
outbound goes out -- the contractor still gets confirmation.
