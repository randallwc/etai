AMBIGUOUS.AI -- the system of record
====================================

Calendar, tasks, CRM, mail, documents, and the assistant/chat LLM all
live in the etai-workspace Ambiguous workspace. Base
https://app.ambiguous.ai/api, Bearer ak_ key on every request; the
live OpenAPI spec at /api/openapi.json wins when docs and reality
disagree.

One boundary per side, never fetch it anywhere else:

  messaging/ambiguous.js        backend: calendar CRUD, tasks, CRM,
                                assistant/chat
  frontend/src/api/ambiguous.js browser: calendar + contacts, transcripts
  messaging/transports.js       ambimail outbound via /api/mail/send
  messaging/mailpoller.js       inbound via /api/mail/inbox

Env: AMBIG_API or AMBIGUOUS_API_KEY, AMBIGUOUS_BASE_URL. Keys live in
repo-root .env, never in code.

WORKSPACE SETUP
---------------

Provisioned 2026-09-12 via `npx ambiguous auth signup --name etai
--human-email <email> --workspace-name etai`; the API key landed in
./.ambi/config.json (gitignored) and was copied into
frontend/.env.local. The workspace stays "provisional" until the human
clicks the emailed verification link - POST
/api/admin/users/provision-agent 403s until then (the primary agent
works fine). After verification, provision more personas with
provision-agent {display_name}; they show up in GET /api/users with
type "agent".

CLI: `npx ambiguous@latest catalog` lists the whole API, `api
GET|POST <path> -d '<json>'` is the raw escape hatch. Auth resolves
from AMBI_API_TOKEN, then ./.ambi/config.json (searched upward).

VERIFIED ENDPOINTS (live 2026-09-12)
------------------------------------

  GET  /api/users                     {data:[...]}, filter type "agent"
  GET  /api/calendars                 {data:[...]}, is_default picks the
                                      booking calendar
  GET  /api/calendars/events?start&end        day summaries
  GET  /api/calendars/availability?user_ids&start&end
                                      {availability:{userId:[busy]}}
  POST /api/calendars/:id/events      {title,start_at,end_at,attendees}
  POST /api/tasks                     {title} -> {task:{...}} (wrapped)
  POST /api/documents                 {type:"doc",title,content} - call
                                      transcripts land here
  POST /api/assistant/chat            intent classification; ~30s
                                      agentic-loop timeout, so
                                      scheduling stays on primitives
  POST /api/forms                     intake form; public fill page at
                                      /f/{workspace_slug}/{slug}
  POST /api/sign                      draft from a doc; signers, fields
                                      (0-1 coords), prepare-send works,
                                      confirm-send returns
                                      CONFIRM_REQUIRES_HUMAN - a human
                                      taps send in the Sign UI
  POST /api/crm/deals, /api/crm/activities    booking paperwork trail
  GET  /api/calendars/upcoming-reminders?window_hours=   reminder feed;
                                      only events that HAVE reminders
  GET  /api/mail/inbox?unread=true    carrier-gateway SMS replies
  POST /api/mail/send                 ambimail outbound texts
  GET  /api/calendars/{id}/publish    public .ics - rejected, exposes
                                      the whole calendar

List endpoints paginate {data, total, has_more}.

GOTCHAS
-------

- Provisional workspace blocks provision-agent until the human
  verifies; coworkers dispatch also needs a coworker_service_id that
  only post-verification personas get, so the service acts AS the
  workspace agent.
- Availability only covers workspace members - never client
  calendars.
- No push path for inbound mail exists; polling the inbox is it.
  POST /api/webhooks does exist for event.* pushes once the service
  has a public URL.
- There is no delivery signal on carrier-gateway sends: a wrong
  gateway is a silent drop with a 200 (see docs/messaging.md).

APPROACHES TRIED AND REJECTED
-----------------------------

- MCP for the call UI: a tool-calling transport for agent runtimes,
  not an API a browser should hold a key for. Plain REST won.
- Transcript as a task: a document won - prose meant for review, and
  documents render natively in the workspace UI.
- CopilotKit for a dispatcher board: AG-UI state is run-scoped, not
  broadcast, so the loop would have to trigger a run per message.
  Prototyped on the deleted copilot-sms-imessage branch; recoverable
  from git history.
