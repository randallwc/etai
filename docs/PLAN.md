PLAN -- remaining work, four agents, coordination
================================================

Read docs/FINAL_CLEANUP.md first (what broke and why), then
docs/reliability.md (the listener contract) and docs/SPEC.md (module
map). This file assigns the remaining work to four agents and defines
how they avoid colliding.

NORTH STAR
----------

One phone number, two parties. A client texts to book/move/cancel/ask;
the agent answers every time, fast, against the in-memory calendar
mirror, and pushes to Ambiguous in batches. The contractor texts the
same way and affected clients get told. Every seam degrades: no AI key
means keyword classify, no Ambiguous means the stub calendar, no
subscriber means the retry queue.

FOUR AGENTS, FOUR SEAMS
-----------------------

Agent A -- Messaging and transport.
  Owns messaging/* and shared/env.js. Nobody else touches these files.

  Tasks:
    1. Collapse CARRIER_GATEWAYS and GATEWAY_MAP into one per-recipient
       mechanism; update .env.example and SHARED_MEMORY.md to match.
    2. mailpoller: mark non-gateway mail read (or quarantine it) so the
       same message stops being fetched every poll.
    3. ALLOWED_FROM: document it in .env.example; warn in healthz when
       CONTRACT_PHONE is not in the list.
    4. Persist the undelivered queue to disk (JSON next to
       bus/.state.json) so a messaging restart cannot drop inbound.
    5. Run messaging tests; keep the mailpoller inflight test green.

Agent B -- Bus and conversation.
  Owns bus/loop.js, bus/ai.js, bus/state.js, bus/calendar.js and the bus
  tests. The pending-* TTL work and async save land here.

  Tasks:
    1. Apply PROPOSAL_TTL_MS expiry to pendingClarify and pendingDedup
       (same wedge as the stale proposal we debugged live).
    2. Test: createEvent -> pushSoon -> remote write without waiting for
       the sync tick; sync() stays the backstop for remote pulls.
    3. Open-spot re-offer: when a client cancel frees a slot and a
       waitlist exists, propose new times instead of just confirming.
    4. Route /webhooks/calendar client-facing updates through
       loop.clientUpdate; contractor keeps the direct text. One owner,
       no double-notify.
    5. Commit the in-flight batch (TTL, pushSoon, parallel notify,
       async state writer) once tests pass.

Agent C -- Voice and real-phone E2E.
  Owns bus/tts.js, the /voice/turn and /tts seams, and scripts/demo*.

  Tasks:
    1. Decide msedge-tts: add it to package.json (pinned, >=7 days old)
       or remove the /tts endpoint. No half-installed seams.
    2. Real-phone matrix on +15550100100: book -> pick -> locked in;
       running late -> client ETA text; cancel -> rebook offer; day
       summary; a text during a messaging restart (retry buffer
       delivers it).
    3. Measure and log ack latency and answer latency per turn; the bar
       is ~2s ack, ~10s answer.
    4. Verify the contractor-only intents (running_late moves the job,
       client late does not) against the live service.

Agent D -- Frontend and demo readiness.
  Owns frontend/*, docs/demo-day.md, scripts/serve.sh + watchdog.sh +
  update.sh + listen.sh.

  Tasks:
    1. Create frontend/.env.local (VITE_AMBIGUOUS_API_KEY,
       VITE_MESSAGING_URL) and get `npm run dev` + `npm test` green.
    2. Dispatcher board against the live messaging /send; confirm CORS
       and the etAI prefix show up right.
    3. Triage the Dependabot alerts (1 critical) in frontend deps;
       upgrade or document the rejection.
    4. Demo checklist: services supervised via watchdog+serve.sh,
       listen.sh tailing inbound, calendar seeded, .env.example
       accurate for a fresh clone.

COORDINATION RULES
------------------

  - Ownership is exclusive by file, not by directory. If your task
    needs a file another agent owns, write the ask in SHARED_MEMORY.md
    under a new "HANDOFFS" heading and move on to the next task.
  - Pull --rebase --autostash before every push. On conflict, keep the
    remote version of code you do not own and re-apply yours on top.
  - Every commit must pass root npm test (the hook enforces it). Do not
    commit with a broken suite to "fix later".
  - New env var -> same commit adds it to .env.example with a comment.
  - Reply text lives in loop.js say() strings; transports never
    compose message bodies. The "etAI update:" prefix is added once in
    messaging/index.js /send -- never in the loop.
  - External calls get AbortSignal timeouts; nothing unbounded in the
    turn path.
  - When your list is empty, check SHARED_MEMORY.md HANDOFFS and then
    the test suite for failures before idle.

ORDER OF OPERATIONS
-------------------

  1. Agent B lands the in-flight batch first (everyone rebases on it).
  2. Agents A and C work in parallel; A's gateway collapse and C's
     E2E matrix both depend on B's commit being green.
  3. Agent D starts on frontend env (independent), then runs the demo
     checklist last, after A/B/C report green.
  4. Final: one agent runs scripts/update.sh, verifies both healthz
     endpoints, runs the real-phone matrix once more, and updates
     SHARED_MEMORY.md with what changed.
