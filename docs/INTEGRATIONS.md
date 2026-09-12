External integrations
=====================

The systems this repo talks to and where each boundary lives. Endpoint
shapes and deep gotchas stay in the per-service docs -- this file is the
map.

Ambiguous.ai
------------

Ambiguous is the system of record (workspace etai-workspace). Calendar,
tasks, CRM contacts, mail, documents, and the assistant/chat LLM all
come from it. Base https://app.ambiguous.ai/api, auth is a Bearer key on
every request; the live OpenAPI spec at /api/openapi.json is the source
of truth when docs and reality disagree.

One boundary per component -- never fetch Ambiguous from anywhere else:

  frontend/src/api/ambiguous.js   browser side: roster, day summary,
                                booking, transcripts. Degrades to
                                offline mode with no key.
  agent/ambiguous.js              agent core: calendar CRUD, tasks,
                                CRM upsertContact.
  bus/index.js                    inbound prose -> assistant/chat ->
                                reply texted back out.
  messaging/transports.js         ambimail transport: POST /api/mail/send
                                to <number>@carrier-gateway for outbound
                                SMS with no Mac.
  messaging/mailpoller.js         GET /api/mail/inbox?unread=true polled
                                for gateway replies; consumed items are
                                marked read.
  calendar-agent/                 assistant/chat smoke script plus
                                notify.js polling upcoming-reminders
                                into the bus webhook.

Env keys: AMBIG_API or AMBIGUOUS_API_KEY (either works; AMBIG_API is
read first in the messaging service), AMBIGUOUS_BASE_URL to point at a
non-default host. Keys live in repo-root .env via shared/env.js, never
in code.

Gotchas worth restating: fresh workspaces are provisional (no
provision-agent until the human verifies); act AS the workspace agent,
coworker dispatch needs a post-verification persona; availability only
covers workspace members, never external clients; there is no push path
for inbound -- polling the mail inbox is it. Full detail:
docs/ambiguous-integration.md, docs/messaging.md, docs/agent.md.

CopilotKit
----------

Not installed -- a documented stretch path for a dispatcher demo board,
and deliberately nothing in the MVP depends on it. The product surface
is the phone; a board is presentation only.

If it gets built, the recipe (from docs/API.md): CopilotKit v2,
CopilotRuntime with BuiltInAgent mounted inside the existing Node app,
React page under a CopilotKit provider with no chat component, useAgent
to render job state and useRenderTool to draw each tool call as a status
card. /v2 subpath imports throughout -- most tutorials still show the
deprecated v1 API. Needs Node 20+ and one LLM key; no CopilotKit
account. COPILOT_API is already reserved in .env.example.

The structural caveat: AG-UI state is run-scoped, not broadcast. The
board does not update on its own -- each inbound message that should
move a card must trigger a run server-side, so the agent loop posts
into the runtime rather than the runtime watching the loop.

Rejected uses, so nobody re-litigates them: CopilotKit Channels for
messaging (no shipped SMS/iMessage adapter; the WhatsApp one needs Meta
app credentials) and any product dependency on the board (it is a demo
surface, not the product).

Other external parts
--------------------

BlueBubbles (real iMessage, needs a Mac), LoopMessage sandbox and Twilio
(fallback SMS), and carrier email-to-SMS gateways are documented in
docs/PHONE.md, docs/messaging.md and docs/API.md. Vapi or Bland is the
voice-call path when it lands; the agent-side seam (POST /voice/turn)
already exists.
