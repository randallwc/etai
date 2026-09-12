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
  agent/             the agent core -- consumes messaging inbound +
                     /voice/turn, intent via assistant/chat -> Ambiguous ->
                     reply. Docs: docs/agent.md. Tests: agent/tests/
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
  - Never commit secrets. Keys live in repo-root .env (gitignored);
    services load it via shared/env.js loadEnv() in their entry point.
    Names in use: AMBIG_API, COPILOT_API, CONTRACT_PHONE, CLIENT_PHONE.

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

  - assistant/chat RESOLVED: it is live and is the agent's intent
    classifier (agent/ai.js). Returns {response:"..."} with JSON inside;
    tolerant extraction in extractJson. Earlier "absent" reports were
    stale.
  - Fresh workspaces are "provisional": provision-agent 403s until the
    human owner clicks the verification email. The signup agent works.
  - coworkers dispatch needs coworker_service_id, only present on
    persona-backed coworkers created post-verification. Act AS the agent.
  - Ambiguous list endpoints paginate {data,total,has_more}.
  - iMessage needs a Mac running BlueBubbles; the only other real outbound
    path today is ambimail (Ambiguous mail.send -> number@vtext.com),
    wired into messaging/ transports -- Verizon-only, outbound-only, and
    the gateway dies ~March 2027. Live sends to 5550100102 and
    5550100100 went out on 2026-09-12; confirmed in /api/mail/sent but
    handset delivery unconfirmed (vtext gives no receipt). Replies would
    land in the workspace mail inbox (/api/mail/inbox) -- unproven as an
    inbound path, inbox was empty at test time. Sim transport remains
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

  - Real INBOUND transport is the gap: the agent core is built and
    tested end to end against sim/stub, but no provider delivers
    inbound texts yet (BlueBubbles needs a Mac; LoopMessage is
    inbound-initiated; Twilio is the fallback).
  - Voice calls: the seam is ready -- POST {agent}/voice/turn takes
    {from, body} and returns {reply} to speak; the caller is not
    texted, counterparties are. A Vapi tool-call or frontend JS maps
    straight onto it. docs/agent.md has the contract.
  - bus/ is empty; user-interface/ is empty (frontend/ is the real UI).

AGENT ARCHITECTURE
----------------
agent/ is now: index.js (HTTP + wiring), loop.js (intent->tools->reply),
ai.js (LLM classify via Ambiguous assistant/chat, schema
models/intent.schema.json), state.js (createStore(file|null); null =
memory-only for tests), calendar.js (adapter: listDay, proposeSlots,
createEvent/updateEvent/cancelEvent + resolveDayRef/partsInTz helpers +
in-memory stubCalendar when no key), reminders.js (pre-job heads-up
texts). index.js createAgentServer(env, overrides) accepts injected
ambi/calendar/ai/store/notify/loop for tests.

Voice seam: loop.handle(msg) returns the reply text when
msg.channel === "voice" instead of texting it to the caller; index.js
exposes that as POST /voice/turn {from, body} -> {reply}. Counterparty
notifications still go through notify() -> messaging /send.

Make: every component has a Makefile (run/test); root Makefile
delegates -- `make test` == `npm test`, `make run-agent` etc.
