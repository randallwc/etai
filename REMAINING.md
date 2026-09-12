REMAINING -- open work after the live bring-up
================================================

Read docs/FINAL_CLEANUP.md first -- it is the detailed audit of which
assumptions broke and why. This file is the short list of what is left.

NOW (correctness, do these first)
---------------------------------

  1. TTL the rest of the pending state. PROPOSAL_TTL_MS covers
     pendingProposal and pendingBook; pendingClarify and pendingDedup
     still wedge a thread forever if the client never answers. Same
     fix shape, top of handle() in bus/loop.js.

  2. Persist the undelivered queue. messaging/index.js queues inbound
     it cannot fan out, but the queue is in-memory -- a messaging
     crash loses it. Mail survives via unread-retry; sim/BlueBubbles
     webhooks do not. Either a JSON spool file next to state or mark
     upstream mail unread on crash.

  3. Prove pushSoon end-to-end. Local writes flush to Ambiguous on
     setImmediate now (bus/calendar.js); no test yet asserts create ->
     remote POST without calling sync() first.

  4. Pick one carrier-gateway config. CARRIER_GATEWAYS (JSON map) and
     GATEWAY_MAP (blast list) overlap in messaging/transports.js.
     Decide which wins, delete the other.

SOON (demo-critical)
--------------------

  5. /tts returns 503: msedge-tts is lazily required but not in
     package.json. Add the dependency or drop the endpoint before a
     demo that plays audio.

  6. frontend/.env.local is missing (VITE_AMBIGUOUS_API_KEY,
     VITE_MESSAGING_URL) -- the dispatcher board cannot run until it
     exists.

  7. ALLOWED_FROM filters inbound to the demo phone. CONTRACT_PHONE is
     the same number today, so contractor texts still get through --
     the moment the contractor uses another phone they are filtered
     too. Either allowlist both numbers or drop the filter post-demo.

  8. Turn-timeout reply quality: when the 30s turn timeout fires the
     caller gets the generic "recorded shortly" text even though the
     turn often completes moments later. Consider re-sending the real
     reply when it lands, or raising the timeout.

LATER (known gaps, not blocking)
--------------------------------

  9. Open-spot re-offer: on cancel/move, clients waiting on that day
     should be offered the freed slot. Spec in docs/PLAN.md item 3.

 10. /webhooks/calendar only texts the contractor. Client-facing
     updates from calendar events are not routed through
     loop.clientUpdate yet.

 11. mailpoller re-skips non-gateway mail (7f93a441) every poll and
     never marks it read -- noise now, cost as the inbox fills.

 12. Non-Verizon inbound channel: ambimail is Verizon-only, no
     delivery receipts, gateway dies ~March 2027. BlueBubbles needs a
     Mac; Twilio is the fallback.

 13. npm audit: 7 vulns on main, 1 critical. Untriaged.

 14. Turn-queue timeout: enqueue() in bus/index.js rejects a turn at
     30s but the underlying handle() keeps running -- a slow Ambiguous
     call still holds the thread chain.

DONE AND VERIFIED (for context, not to redo)
--------------------------------------------

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
