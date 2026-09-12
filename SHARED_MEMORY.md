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
  calendar-agent/    Ambiguous assistant/MCP scripts + notify.js, which
                     polls /api/calendars/upcoming-reminders and POSTs due
                     reminders to {BUS_URL}/webhooks/calendar. Contract:
                     models/calendar-notification.schema.json,
                     docs/notifications.md
  messaging/         messaging service: POST /send out, POST /subscriptions
                     to receive normalized inbound, /webhooks/bluebubbles
                     for real iMessage, /simulate/inbound to test without
                     a Mac. Contract: models/phone-contract.schema.json,
                     docs/messaging.md
  bus/               the one brain: central router + agent core merged
                     2026-09-13 (agent/ no longer exists). Consumes
                     messaging inbound + /voice/turn, classifies intent
                     via assistant/chat, runs the loop in loop.js against
                     bus/ambiguous.js, replies via messaging /send.
                     Also: /webhooks/calendar (notify feed -> contractor
                     text), /internal/digest, /internal/client-update.
                     Docs: docs/bus.md. Tests: bus/tests/
  models/            JSON Schemas only (*.schema.json), one per shape;
                     includes the agent data model (contractor, customer,
                     job, agent-action, message) for the bus core
  shared/            zero-dep helpers shared by services (env.js loads
                     .env without overriding set vars)
  docs/              all documents live here; unix format, no tables

CONVENTIONS
-----------

  - JavaScript CommonJS, no dependencies. Platform fetch/http only.
    Exception: bus/ carries @copilotkit/runtime (bus/package.json) for
    the CopilotKit agent path; bus/copilot.js still loads it lazily so
    the service runs without node_modules installed.
  - Tests: node:test files under <component>/tests/*.test.js. `npm test`
    globs that pattern -- tests must match it or they do not run.
    calendar-agent/test.js is a manual smoke script, not a unit test; the
    glob exists so it is not picked up by the runner.
  - .githooks/pre-commit runs npm test on every commit
    (core.hooksPath=.githooks is set repo-wide).
  - Commits: one-line heading plus 2-3 sentences; keep them short.
  - Never commit secrets. Keys live in repo-root .env (gitignored);
    services load it via shared/env.js loadEnv() in their entry point.
    Names in use: AMBIG_API, AMBIGUOUS_API_KEY, COPILOT_API,
    COPILOT_AGENT, COPILOT_MODEL, COPILOT_RUN_TIMEOUT_MS,
    CONTRACT_PHONE, CLIENT_PHONE, BUS_URL, GATEWAY_MAP, ALLOWED_FROM,
    UNDELIVERED_FILE (see .env.example).
    COPILOT_API is a cpk- Intelligence project key, not an LLM key.

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
    classifier (bus/ai.js). Returns {response:"..."} with JSON inside;
    tolerant extraction in extractJson. Earlier "absent" reports were
    stale.
  - Fresh workspaces are "provisional": provision-agent 403s until the
    human owner clicks the verification email. The signup agent works.
  - coworkers dispatch needs coworker_service_id, only present on
    persona-backed coworkers created post-verification. Act AS the agent.
  - Ambiguous list endpoints paginate {data,total,has_more}.
  - iMessage needs a Mac running BlueBubbles; the working path today is
    ambimail (Ambiguous mail.send -> number@vtext.com), now proven
    TWO-WAY: a real reply from 4253625633 landed in /api/mail/inbox on
    2026-09-12, and messaging/mailpoller.js polls it every 15s
    (?unread=true, marks read after accept). Gotchas: mail.send IGNORES
    body_text silently -- must send body_markdown or the phone gets an
    empty "ETAi" subject-only text. Replies arrive from vzwpix.com (MMS)
    with the text in a text_0.txt attachment and preview "(no content)"
    -- the poller fetches the attachment in that case. Verizon-only,
    no delivery receipts, gateway dies ~March 2027. Sim transport
    remains for offline work.
  - Phone normalization: toE164 adds +1 for 10-digit inputs -- sim and
    mail inbound agree on +1XXXXXXXXXX threadKeys. A message normalized
    without the 1 (+4253...) misses jobForPhone lookups silently.
  - agent/ merged into bus/ ("one brain"): the loop, ai, state,
    calendar, and ambiguous client now live in bus/. The agent needs
    PUBLIC_URL + MESSAGING_URL to self-subscribe to messaging fanout,
    and re-subscribes every 30s so a messaging restart does not leave
    it deaf.
  - Inbound is never dropped on a dead subscriber: messaging queues
    undelivered messages and re-fans them every FANOUT_RETRY_MS (5s)
    up to FANOUT_RETRY_MAX (24) times. accepted:false means "queued,
    not delivered yet" -- a redelivery of a queued message retries
    immediately. The queue is written to UNDELIVERED_FILE (default
    /tmp/etai-undelivered.json) on every change and reloaded at boot,
    so a messaging restart no longer drops queued inbound. /healthz
    shows queued count and, when ALLOWED_FROM is set, its size as
    "allowed" plus a warn when CONTRACT_PHONE is not on the list.
  - bus/calendar.js is a memory mirror, not a live passthrough: every
    listDay/proposeSlots/create/update/cancel is local-only. Writes
    reach Ambiguous on sync() -- at boot, every CALENDAR_SYNC_MS (30s),
    and on /webhooks/calendar hits. Tests that assert Ambiguous writes
    MUST call calendar.sync() first. Local ids are stable; remoteIds
    translate at push, so job.ambiguousEventId stays a local id.
    CALENDAR=memory forces the zero-API stub even with a key set.
  - Loop turns serialize through a promise chain in bus/index.js
    (enqueue) -- a booking text and its slot pick can no longer race.
    Do not call loop.handle directly from new entry points; go through
    the same queue.
  - The stub calendar throws {code:"conflict"} on overlapping writes;
    apply() returns per-op error results rather than aborting.
  - Frontend -> messaging is cross-origin: messaging answers OPTIONS
    and sets allow-*. If you add a service the UI calls, do the same.
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

  - Real inbound is now live via mailpoller (ambimail replies ->
    /api/mail/inbox). What is still missing: a real phone-number-bound
    channel for non-Verizon clients (BlueBubbles needs a Mac;
    LoopMessage is inbound-initiated; Twilio is the fallback) and any
    delivery receipt -- vtext drops silently.
  - Voice calls: the seam is ready -- POST {agent}/voice/turn takes
    {from, body} and returns {reply} to speak; the caller is not
    texted, counterparties are. A Vapi tool-call or frontend JS maps
    straight onto it. docs/bus.md has the contract.
  - user-interface/ is empty (frontend/ is the real UI).

AGENT ARCHITECTURE
----------------
bus/ is now: index.js (HTTP + wiring + serialized turn queue),
loop.js (intent->tools->reply; console, voice, and copilot fallback),
copilot.js (CopilotKit BuiltInAgent path for sms+imessage; tools wrap
calendar/store/notify, schema models/copilot-agent.schema.json;
enabled by COPILOT_MODEL/LLM key, or COPILOT_AGENT=on for the Ambiguous
assistant/chat factory), ai.js (LLM classify via Ambiguous
assistant/chat, schema models/intent.schema.json, keyword fallback on
timeout), state.js (createStore(file|null); null = memory-only for
tests), calendar.js (in-memory mirror over stubCalendar + batch
push/pull sync to Ambiguous; resolveDayRef/partsInTz/findSlots
helpers), reminders.js (pre-job heads-up texts). index.js
createBusServer(env, overrides) accepts injected
ambi/calendar/ai/store/notify/loop/copilot for tests.

Voice seam: loop.handle(msg) returns the reply text when
msg.channel === "voice" instead of texting it to the caller; index.js
exposes that as POST /voice/turn {from, body} -> {reply}. Counterparty
notifications still go through notify() -> messaging /send.

Make: every component has a Makefile (run/test); root Makefile
delegates -- `make test` == `npm test`, `make run-bus` etc.

HANDOFFS
--------

  - bus/index.js /webhooks/calendar (owner: whoever takes it; Agent B
    cannot edit index.js): the handler texts only the contractor via
    notifyContractor(). Route client-facing event types through
    loop.clientUpdate(phone) instead: it already sends the "You have X
    at Y, reply to move" text and logs client_update actions. To find
    the phone, match the notification's event to a store job
    (calendar.events carry remoteId; job.ambiguousEventId is the local
    id, so match on remoteId for pushed events or id for pulled ones).
    Caveat: clientUpdate only texts jobs still status "confirmed" with
    a future window, so for event.deleted the job status must be
    reconciled first or no client text goes out.

  - .env.example (Agent D): now documents every env var the stack reads
    (ALLOWED_FROM, FETCH_TIMEOUT_MS, UNDELIVERED_FILE, TTS_VOICE,
    TURN_TIMEOUT_MS, WORKING_BEAT_MS, SEND_TIMEOUT_MS, SEND_RETRY_MS,
    CONTRACTOR_PHONE alias, AMBIGUOUS_DAYS, PORT). If A/B/C add or
    rename a var, flag it here rather than editing the file mid-flight.
  - frontend/.env.local (Agent D): created with the real AMBIG key,
    VITE_MESSAGING_URL=http://localhost:4020, VITE_BUS_URL=
    http://localhost:4010, and VITE_DEMO_PHONE=+14253625633 so board
    texts reroute to the demo phone. Verified end to end: POST /send
    from the board payload shape returns an ambimail externalId and the
    "etAI update: " prefix is applied server-side.

  - docs/demo-day.md (Agent D owns it): still describes
    CARRIER_GATEWAYS (env table ~line 40, silent-drop note ~line 153).
    That mechanism is deleted -- GATEWAY_MAP won because one entry can
    blast several domains. The same pins now read
    GATEWAY_MAP=4253625633:vtext.com,8177136090:txt.att.net and
    CARRIER_GATEWAY stays the fallback for unlisted numbers.
