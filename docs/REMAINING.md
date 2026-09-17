REMAINING -- open work after the live bring-up
================================================

Read docs/FINAL_CLEANUP.md first -- it is the detailed audit of which
assumptions broke and why. This file is the short list of what is left.

NOW (correctness, do these first)
---------------------------------

SOON (demo-critical)
--------------------

  1. /tts returns 503: msedge-tts is lazily required but not in
     package.json. Add the dependency or drop the endpoint before a
     demo that plays audio.

  2. frontend/.env.local is missing (VITE_AMBIGUOUS_API_KEY,
     VITE_MESSAGING_URL) -- the dispatcher board cannot run until it
     exists.

  3. ALLOWED_FROM filters inbound to the demo phone. CONTRACT_PHONE is
     the same number today, so contractor texts still get through --
     the moment the contractor uses another phone they are filtered
     too. Either allowlist both numbers or drop the filter post-demo.

  4. Turn-timeout reply quality: when the 30s turn timeout fires the
     caller gets the generic "recorded shortly" text even though the
     turn often completes moments later. Consider re-sending the real
     reply when it lands, or raising the timeout.

LATER (known gaps, not blocking)
--------------------------------

  5. Open-spot re-offer: on cancel/move, clients waiting on that day
     should be offered the freed slot. Spec in docs/PLAN.md item 3.

  6. /webhooks/calendar only texts the contractor. Client-facing
     updates from calendar events are not routed through
     loop.clientUpdate yet.

   7. Non-Verizon inbound channel: ambimail is Verizon-only, no
     delivery receipts, gateway dies ~March 2027. BlueBubbles needs a
     Mac; Twilio is the fallback.

  8. npm audit: 7 vulns on main, 1 critical. Untriaged.

  9. Turn-queue timeout: enqueue() in bus/index.js rejects a turn at
     30s but the underlying handle() keeps running -- a slow Ambiguous
     call still holds the thread chain.

  10. CopilotKit agent path for sms/imessage: prototyped on the deleted
     copilot-sms-imessage branch (bus/copilot.js, docs/copilotkit.md,
     models/copilot-agent.schema.json). Future improvement if the
     current loop needs a richer agent runtime; recover the code from
     git history if revived.

DONE AND VERIFIED (for context, not to redo)
--------------------------------------------

  - pendingClarify and pendingDedup expire on PROPOSAL_TTL_MS; no
    pending state can wedge a thread now.
  - Undelivered queue persists to UNDELIVERED_FILE
    (models/undelivered-queue.schema.json); a messaging crash no
    longer loses queued inbound.
  - pushSoon covered: createEvent pushes to Ambiguous on setImmediate,
    sync() is backstop only (bus/tests/calendar.test.js).
  - Carrier routing is GATEWAY_MAP only; CARRIER_GATEWAYS was removed.
  - mailpoller marks non-gateway mail read instead of re-skipping it
    every poll.
  - /healthz reports the allowlist size and warns when CONTRACT_PHONE
    is not in ALLOWED_FROM.

  - Per-thread turn queues replace the global lock (bus/index.js).
  - 1.5s "On it" working beat; canceled when the real reply lands.
  - Keyword fast-path for dated requests off the LLM (bus/ai.js).
  - Undelivered fanout queue + retry, bus re-subscribes every 30s.
  - Async dirty-flag state writer (bus/state.js) -- writeFileSync is
     off the reply path.
  - Local-first calendar with immediate async push (pushSoon) and
     periodic sync() as backstop.
  - Per-member supervision in scripts/serve.sh -- one dead member no
     longer restarts the stack.
  - Stale proposals expire (PROPOSAL_TTL_MS) so old offers cannot
     hijack new messages.
  - findSlots floors at now+15min so Ambiguous never rejects a pick
     for being in the past.
