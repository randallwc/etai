REMAINING -- open work
======================

This file is the short list of what is left.

SOON
----

  1. /tts returns 503: msedge-tts is lazily required but not in
     package.json. Add the dependency or drop the endpoint before a
     demo that plays audio.

  2. frontend/.env.local is missing (VITE_AMBIGUOUS_API_KEY,
     VITE_BUS_URL) -- the dispatcher board and call path need it.

  3. ALLOWED_FROM filters inbound to the demo phone. CONTRACT_PHONE is
     the same number today, so contractor texts still get through --
     the moment the contractor uses another phone they are filtered
     too. Either allowlist both numbers or drop the filter.

LATER (known gaps, not blocking)
--------------------------------

  4. Open-spot re-offer: on cancel/move, clients waiting on that day
     should be offered the freed slot.

  5. /webhooks/calendar only texts the contractor. Client-facing
     updates from calendar events are not routed through
     loop.clientUpdate yet.

  6. Non-Verizon inbound channel: ambimail is Verizon-only, no
     delivery receipts, gateway dies ~March 2027. BlueBubbles needs a
     Mac; Twilio is the fallback.

  7. npm audit: 7 vulns on main, 1 critical. Untriaged.

  8. CopilotKit agent path for sms/imessage: prototyped on the deleted
     copilot-sms-imessage branch. Future improvement if the loop needs
     a richer agent runtime; recover the code from git history if
     revived.

DONE AND VERIFIED (for context, not to redo)
--------------------------------------------

  - pendingClarify and pendingDedup expire on PROPOSAL_TTL_MS; no
    pending state can wedge a thread now.
  - pushSoon covered: createEvent pushes to Ambiguous on setImmediate,
    sync() is backstop only.
  - Carrier routing is GATEWAY_MAP only; CARRIER_GATEWAYS was removed.
  - mailpoller marks non-gateway mail read instead of re-skipping it
    every poll.
  - /healthz reports the allowlist size and warns when CONTRACT_PHONE
    is not in ALLOWED_FROM.
  - Per-thread turn queues replace the global lock; the voice-turn
    timeout only bounds the caller-facing reply and its timer is
    cleared when the turn settles.
  - 1.5s "On it" working beat; canceled when the real reply lands.
  - Keyword fast-path for dated requests off the LLM (messaging/ai.js).
  - Async dirty-flag state writer (messaging/state.js) -- writeFileSync
    is off the reply path.
  - Local-first calendar with immediate async push (pushSoon) and
    periodic sync() as backstop.
  - Stale proposals expire (PROPOSAL_TTL_MS) so old offers cannot
    hijack new messages.
  - findSlots floors at now+15min so Ambiguous never rejects a pick
    for being in the past.
  - The bus and messaging services merged into messaging/index.js --
    inbound feeds the loop in-process, no fanout layer.
