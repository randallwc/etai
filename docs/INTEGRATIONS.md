External integrations
=====================

The systems this repo talks to and where each boundary lives. Endpoint
shapes and deep gotchas stay in the per-service docs -- this file is
the map.

Ambiguous.ai
------------

Ambiguous is the system of record (workspace etai-workspace). Calendar,
tasks, CRM contacts, mail, documents, and the assistant/chat LLM all
come from it. Base https://app.ambiguous.ai/api, auth is a Bearer key
on every request; the live OpenAPI spec at /api/openapi.json is the
source of truth when docs and reality disagree.

One boundary per component -- never fetch Ambiguous from anywhere
else:

  frontend/src/api/ambiguous.js   browser side: calendar events +
                                  CRM contacts for the board, call
                                  transcripts. Disabled with no key.
  messaging/ambiguous.js          backend: calendar CRUD, tasks, CRM
                                  upsertContact, assistant/chat for
                                  intent classification.
  messaging/transports.js         ambimail transport: POST
                                  /api/mail/send to
                                  <number>@carrier-gateway for
                                  outbound SMS with no Mac.
  messaging/mailpoller.js         GET /api/mail/inbox?unread=true
                                  polled for gateway replies; consumed
                                  items are marked read.
  messaging/index.js              polls /calendars/upcoming-reminders
                                  for contractor notifications.

Env keys: AMBIG_API or AMBIGUOUS_API_KEY, AMBIGUOUS_BASE_URL to point
at a non-default host. Keys live in repo-root .env via shared/env.js,
never in code.

Gotchas worth restating: fresh workspaces are provisional (no
provision-agent until the human verifies); act AS the workspace agent,
coworker dispatch needs a post-verification persona; availability only
covers workspace members, never external clients; there is no push
path for inbound -- polling the mail inbox is it. Full detail:
docs/ambiguous-integration.md, docs/messaging.md.

CopilotKit
----------

Not installed -- a documented stretch path for a dispatcher board,
and nothing depends on it. The product surface is the phone; a board
is presentation only. The attempt lived on the deleted
copilot-sms-imessage branch; see docs/REMAINING.md for how to recover
it.

The structural caveat: AG-UI state is run-scoped, not broadcast. The
board does not update on its own -- each inbound message that should
move a card must trigger a run server-side, so the agent loop posts
into the runtime rather than the runtime watching the loop.

Rejected uses, so nobody re-litigates them: CopilotKit Channels for
messaging (no shipped SMS/iMessage adapter; the WhatsApp one needs
Meta app credentials) and any product dependency on the board (it is
a demo surface, not the product).

Other external parts
--------------------

BlueBubbles (real iMessage, needs a Mac), LoopMessage sandbox and
Twilio (fallback SMS), and carrier email-to-SMS gateways are
documented in docs/messaging.md. Vapi or Bland is the voice-call path
when it lands; the agent-side seam (POST /voice/turn) already exists.
