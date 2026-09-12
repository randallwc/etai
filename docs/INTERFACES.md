INTERFACES -- who owns what, and the wires between
==================================================

ETAi is three components behind two HTTP boundaries. Each component can be
built by a different person against these documents alone. If a component
satisfies the examples in its contract, it works -- no shared code required.

                 inbound events
   iMessage/SMS/voice -------> +--------------+      POST /webhooks/inbound
   (BlueBubbles, Twilio,       | PHONE        |------------------------+
    Vapi, LoopMessage)  ------>| SERVICE      |                        |
                               | (phone team) |<------------------+    |
                               +--------------+   POST /send      |    |
                                                                |    v
                               +--------------+   calendar REST | +-------------+
                               | CALENDAR     |<------------------| AGENT       |
                               | SERVICE      |                   | SERVICE     |
                               | (cal team)   |------------------>| (us)        |
                               +--------------+  (none -- the     +-------------+
                                  wraps Ambiguous AI workspace    agent never
                                  API: events, CRM, tasks)        pushes to it)

OWNERSHIP
---------

agent service (us). The agent loop, the job state, and every decision. Owns
two inbound endpoints: POST /webhooks/inbound (normalized messages) and
POST /webhooks/voice-toolcall (stretch, synchronous). Owns the outbound calls
to the other two services.

phone service (phone team). Everything transport-specific: BlueBubbles on the
Mac, LoopMessage or Twilio fallbacks, and later Vapi/Bland voice. Normalizes
every inbound message into our JSON shape and exposes POST /send for
outbound. Contract in PHONE.md.

calendar service (calendar team). Everything Ambiguous-specific: auth,
availability, event CRUD, CRM, tasks. Exposes a small REST surface that
mirrors the agent's five calendar needs. Contract in CALENDAR.md.

THE CONTRACT RULE
-----------------

The JSON shapes in CALENDAR.md and PHONE.md are the contract. Either side may
be replaced by a stub that returns the documented responses; the curl
commands at the end of each doc are conformance tests. When a real response
disagrees with this document, the document wins -- fix the service or update
the doc deliberately, never quietly.

Field conventions shared by both contracts:

  - phone numbers are E.164 (+15551234567)
  - timestamps are ISO 8601 with an explicit offset -- never naive
  - dates without times are the contractor's local day (YYYY-MM-DD)
  - every inbound message carries a provider-unique externalId for dedup
  - errors are JSON { "error": { "code": "...", "message": "..." } }

BUILD ORDER
-----------

  1. Each team stands up its service returning canned contract responses.
  2. Wire inbound first: text in -> normalized POST -> agent logs it.
  3. Wire outbound: agent sends -> /send -> real message lands.
  4. Wire calendar: "what's my day" end to end, then book/cancel/late.
  5. Only then attach real BlueBubbles/Ambiguous credentials.

Mocks mean nobody is ever blocked on anybody. A two-line static file server
or `npx json-server` satisfies each side of the contract until the real
service is ready.

ENV REGISTRY
------------

Set once, shared by the team:

  AGENT_BASE_URL        where the agent listens (ngrok/Cloudflare URL)
  PHONE_SERVICE_URL     where the phone service listens (us -> them)
  CALENDAR_SERVICE_URL  where the calendar service listens (us -> them)

Provider credentials stay with the team that owns the provider:
phone team holds BLUEBUBBLES_*, LOOPMESSAGE_*, TWILIO_*, VAPI_*/BLAND_*;
calendar team holds AMBIGUOUS_API_KEY, AMBIGUOUS_WORKSPACE,
CONTRACTOR_USER_ID; we hold the LLM key. Nobody needs another team's creds.

SEE ALSO
--------

docs/GOAL.md -- product framing, demo script, risks.
docs/API.md  -- the agent's internal tool surface and message flows.
docs/CALENDAR.md -- the calendar service contract.
docs/PHONE.md -- the phone service contract.
