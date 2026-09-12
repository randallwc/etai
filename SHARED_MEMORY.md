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
  models/            JSON Schemas only (*.schema.json), one per shape
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
  GET  /api/users                                  roster (type agent|human)
  GET  /api/calendars                              list; use is_default
  GET  /api/calendars/events?start=&end=           day summary source
  GET  /api/calendars/availability?user_ids=&start=&end=   busy slots; []=free
  POST /api/calendars/:calendar_id/events          {title,start_at,end_at,attendees:[{user_id}]}
  POST /api/tasks                                  {title} -> {task:{...}}
  POST /api/documents                              {type:"doc",title,content}
  MCP endpoint exists at https://app.ambiguous.ai/mcp

LANDMINES
---------

  - POST /api/assistant/chat is NOT in the live OpenAPI catalog.
    calendar-agent/test.js targets it and is stale; compose primitives
    (users + availability + events) instead. Do not extend that script.
  - Fresh workspaces are "provisional": provision-agent 403s until the
    human owner clicks the verification email. The signup agent works.
  - coworkers dispatch needs coworker_service_id, only present on
    persona-backed coworkers created post-verification. Act AS the agent.
  - Ambiguous list endpoints paginate {data,total,has_more}.
  - iMessage needs a Mac running BlueBubbles; there is no other real path
    (LoopMessage sandbox is inbound-initiated only). Sim transport in
    messaging/ exists precisely so nobody is blocked on this.
  - `node --test <dir>` fails -- dirs are not discovered; use the glob.
  - Ambiguous events/bookings are member-centric: availability only exists
    for workspace members (the contractor), not external clients.

CURRENT GAPS
------------

  - No agent core yet: nothing consumes messaging inbound, decides intent,
    calls Ambiguous, and replies. That loop is the next thing to build.
  - bus/ is empty; user-interface/ is empty (frontend/ is the real UI).
  - Voice calls not wired; Vapi preferred (mid-call tool calls), see
    docs/PHONE.md.
