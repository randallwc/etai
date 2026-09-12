FINAL CLEANUP -- audit of broken assumptions and remaining work
===============================================================

Written after the live bring-up on 2026-09-12. Each item names the
assumption that failed, what broke, and what is left to do. Read with
docs/reliability.md (the listener contract) and docs/PLAN.md (who owns
the fixes).

ASSUMPTIONS THAT BROKE, AND WHY
-------------------------------

  1. "Ambiguous calls are fast." assistant/chat stalls for 30-60s under
     load; every inbound waited on it and clients repeated themselves.
     Fixed: keyword fast-path in bus/ai.js, bounded classify, per-thread
     turn queue, 1.5s "On it" working beat. Remaining risk: any new
     external call added to the turn path without a timeout reintroduces
     the wedge. Rule: no unbounded await inside loop.handle.

  2. "A subscriber always exists." Inbound was dropped while the bus
     resubscribed after a messaging restart. Fixed: undelivered queue +
     re-fan every FANOUT_RETRY_MS. Remaining: the queue is in-memory, so
     a messaging process crash loses queued items; mail survives via
     unread-retry, sim/BlueBubbles webhooks do not.

  3. "One global turn lock is enough." A stalled turn wedged every
     thread. Fixed: per-threadKey queues in bus/index.js. Remaining: a
     30s turn timeout still swallows the reply when it fires; the caller
     gets the generic "recorded shortly" text.

  4. "Pending conversation state is fresh." A slot proposal from an
     unanswered text kept intercepting every later message as a pick.
     Fixed: PROPOSAL_TTL_MS expiry on pendingProposal and pendingBook.
     Remaining: pendingClarify and pendingDedup have no TTL yet; same
     wedge shape if a client ignores a clarifying question for an hour.

  5. "Sync writes are enough." Creates waited for the 30s sync to reach
     Ambiguous, so the mirror could lose events if the bus died first.
     Partially fixed: pushSoon() now flushes pending ops immediately on
     write, keeping the periodic sync as backstop. Needs a test proving
     create -> remote push happens without waiting for the tick.

  6. "State writes are cheap." save() did writeFileSync on every action,
     serializing disk I/O into the reply path. Fixed (in-flight): async
     dirty-flag writer in bus/state.js. Remaining: the file is still one
     JSON blob; only the bus may write it. Hand-editing it while the bus
     runs does nothing until restart -- we learned that live.

  7. "Carrier gateway config is settled." Two overlapping mechanisms now
     exist: CARRIER_GATEWAYS (JSON map, per-number domain) and
     GATEWAY_MAP (number:domain[+domain] blast list). One should win;
     see PLAN.md agent A.

  8. "body_text is enough." Ambiguous mail.send silently ignores it;
     only body_markdown reaches the phone. Fixed earlier; still the
     first thing to check when a text arrives empty.

  9. "Every inbound number is wanted." ALLOWED_FROM now filters to the
     demo phone. Assumption to keep in view: CONTRACT_PHONE equals that
     number today, so contractor flows still work. The moment the
     contractor texts from a different number they are filtered too.

 10. "All mail in the inbox is ours." mailpoller skips a non-gateway
     mail (7f93a441) on every poll forever; it never marks it read. It
     is noise now and a growing cost as the inbox fills.

BROKEN OR MISSING RIGHT NOW
---------------------------

  - /tts returns 503: bus/tts.js lazily requires msedge-tts, which is
    not in package.json. Either add the dependency or drop the endpoint.
  - frontend has no .env.local (VITE_AMBIGUOUS_API_KEY,
    VITE_MESSAGING_URL); the dispatcher board cannot run.
  - npm audit / Dependabot: 7 vulns on main, 1 critical. Untriaged.
  - Open-spot re-offer: on cancel/move, affected clients should be
    offered new slots (spec exists in docs/PLAN.md item 3; loop does
    not do it).
  - /webhooks/calendar texts only the contractor; client-facing updates
    from calendar events are not routed through loop.clientUpdate yet.
  - Uncommitted batch in the tree: TTL fix, pushSoon, parallel notify,
    allowlist, async state writer, scripts/*, test updates.

ACCEPTANCE FOR "DONE"
---------------------

  - A real client text gets an ack inside ~2s and an answer inside ~10s,
    even while Ambiguous is slow.
  - book -> pick -> locked in, running late, cancel, day summary all
    verified on real phones end-to-end.
  - One instance of each service, supervised, on latest code.
  - npm test green; no uncommitted work; origin/main in sync.
