SHARED MEMORY -- for every agent working in this repo
=====================================================

Read AGENTS.md first; it wins over any guess, including this file. This file
holds live state and landmines so agents do not have to rediscover them.

WHAT THIS IS
------------

ETAi: agents reachable through channels people already use. Two halves exist
in this repo: the call-your-agent frontend (frontend/, React+Vite, JS) and
the messaging/scheduling backend (messaging/, calendar-agent/, plain Node,
zero deps). Ambiguous.ai workspace etai-workspace is the system of record.

LAYOUT AND OWNERSHIP
--------------------

  frontend/          call UI, personas, src/api/ambiguous.js is THE
                     Ambiguous boundary -- never fetch Ambiguous elsewhere
  calendar-agent/    Ambiguous assistant script (see stale note below)
  messaging/         messaging service: POST /send out, POST /subscriptions
                     to receive normalized inbound, /webhooks/bluebubbles
                     for real iMessage, /simulate/inbound to test without
                     a Mac. Contract: models/phone-contract.schema.json,
                     docs/messaging.md
  agent/             (planned) the agent core -- consumes messaging inbound,
                     intent -> Ambiguous -> reply via /send. Plan and build
                     order: docs/messaging-plan.md
  models/            JSON Schemas only (*.schema.json), one per shape;
                     includes the agent data model (contractor, customer,
                     job, agent-action, message) for the agent core
  shared/            zero-dep helpers shared by services (env.js loads
                     .env without overriding set vars)
  docs/              all documents live here; unix format, no tables
  bus/               reserved, empty

CONVENTIONS
-----------

  - JavaScript CommonJS, no dependencies. Platform fetch/http only.
  - Tests: node:test files under <component>/tests/*.test.js. `npm test`
    globs that pattern -- tests must match it or they do not run.
    calendar-agent/test.js is a manual smoke script, not a unit test; the
    glob exists so it is not picked up by the runner.
  - .githooks/pre-commit runs npm test on every commit
    (core.hooksPath=.githooks is set repo-wide).
  - Commits: one-line heading plus 2-3 sentences; keep them short.
  - Never commit secrets. Ambiguous keys are ak_* in env or .secrets
    (gitignored). *.swp and .secrets* are ignored.

VERIFIED AMBIGUOUS API (live-tested 2026-09-12, workspace etai-workspace)
-------------------------------------------------------------------------

  Base https://app.ambiguous.ai/api, Authorization: Bearer ak_...
  Live OpenAPI 3.1 spec: https://app.ambiguous.ai/api/openapi.json
  (939 paths -- consult it before writing any new call)
  GET  /api/users                                  roster (type agent|human)
  GET  /api/calendars                              list; use is_default
  GET  /api/calendars/events?start=&end=           day summary source
  GET  /api/calendars/availability?user_ids=&start=&end=   busy slots; []=free
  POST /api/calendars/:calendar_id/events          {title,start_at,end_at,attendees:[{user_id}]}
  PATCH/DELETE /api/calendars/events/{id}          update/cancel events
  POST /api/tasks                                  {title} -> {task:{...}}
  POST /api/documents                              {type:"doc",title,content}
  GET,POST /api/crm/contacts                       customer records
  POST /api/mail/send                              email notifications
  GET,POST /api/webhooks  +  GET /api/webhooks/event-types   push to us
  /api/calendars/external/*                        Google/Outlook sync exists
  POST /api/assistant/chat (+ /chat/stream, /api/assistant/conversations)
  MCP endpoint exists at https://app.ambiguous.ai/mcp (401 without key)

LANDMINES
---------

  - assistant/chat status is disputed: docs/ambiguous-integration.md says
    it was absent from the catalog, but it IS in today's live spec
    (/api/openapi.json). If it errors at runtime, compose the verified
    primitives (users + availability + events) like frontend/api does.
  - Fresh workspaces are "provisional": provision-agent 403s until the
    human owner clicks the verification email. The signup agent works.
  - coworkers dispatch needs coworker_service_id, only present on
    persona-backed coworkers created post-verification. Act AS the agent.
  - Ambiguous list endpoints paginate {data,total,has_more}.
  - iMessage needs a Mac running BlueBubbles; the only other real outbound
    path today is ambimail (Ambiguous mail.send -> number@vtext.com),
    wired into messaging/ transports -- Verizon-only, outbound-only, and
    the gateway dies ~March 2027. Two live sends to 2066169257 went out
    this way on 2026-09-12; delivery unconfirmed. Sim transport remains
    for offline work.
  - `node --test <dir>` fails -- dirs are not discovered; use the glob.
  - Ambiguous events/bookings are member-centric: availability only exists
    for workspace members (the contractor), not external clients.
  - core.hooksPath=.githooks bypasses .git/hooks entirely. The hook runs
    only root `npm test` (node:test glob) -- frontend vitest does NOT run
    on commit despite scripts/pre-commit.sh existing. That script was
    never installed here and would be bypassed anyway. Run
    `npm --prefix frontend test` yourself before committing frontend work.

CURRENT GAPS
------------

  - Agent core is the active workstream: nothing yet consumes messaging
    inbound, decides intent, calls Ambiguous, and replies. The plan is
    docs/messaging-plan.md; its data-model schemas are already committed
    under models/. First code step: agent/ skeleton + POST
    /webhooks/inbound intake.
  - bus/ is empty; user-interface/ is empty (frontend/ is the real UI).
  - Voice calls not wired; Vapi preferred (mid-call tool calls), see
    docs/PHONE.md.
