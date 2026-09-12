MESSAGING WORK PLAN -- what we are building on the messaging side
==================================================================

Written 2026-09-12. This is the plan for everything between "a text
arrives" and "a reply goes out." Read docs/messaging.md for the shipped
service, docs/PHONE.md for the wire contract, docs/API.md for the tool
surface this plan implements, and docs/GOAL.md for why.

WHERE WE ARE
------------

Done and tested:

  - messaging/ service: POST /send, POST /subscriptions,
    POST /webhooks/bluebubbles, POST /simulate/inbound, GET /messages,
    GET /healthz. Normalized inbound fans out to subscribers; dedup on
    externalId; self-echo filtered.
  - Sim transport makes the whole pipeline exercisable with no Mac.
    BlueBubbles transport is coded but untested (no Mac on this box).
  - Ambimail transport (added 2026-09-12): outbound texts via Ambiguous
    mail.send to the carrier email-to-SMS gateway (vtext.com).
    Verizon-only, outbound-only, delivery unconfirmed, and the gateway
    is deprecated (~March 2027). A demo stopgap, not the path.
    INBOUND still has no real transport without BlueBubbles.
  - Wire contracts: models/phone-contract.schema.json +
    calendar-contract.schema.json, exercised by models/tests.
  - Data-model schemas for the agent core now committed under models/
    (contractor, customer, job, agent-action, message) -- schema-first
    per AGENT.md before any agent code lands.
  - bus/ service LANDED 2026-09-12: inbound intake, per-thread state,
    assistant/chat intent classification, the four flows, counterparty
    notifications, reminders tick, digest, and the /voice/turn seam.
    See docs/bus.md for what shipped; the items below stay as the
    record of why it is shaped the way it is.

The remaining gap: real INBOUND transport. Everything between "a text
arrives" and "a reply goes out" is built; what is missing is a provider
that can actually deliver inbound texts (BlueBubbles on a Mac, or
LoopMessage/Twilio). Voice calls ride the same loop via /voice/turn.

THE SHAPE OF THE THING
----------------------

One new top-level component: bus/. Plain Node, CommonJS, zero
dependencies -- same conventions as messaging/. It sits behind the
messaging service and never sees a transport.

    iMessage/SMS --> messaging/ --POST--> bus/ --POST /send--> messaging/

The agent service does not replace the calendar-service contract in
docs/CALENDAR.md; it calls the Ambiguous workspace REST API directly
through its own thin client (bus/ambiguous.js -- the backend mirror of
the frontend's src/api/ambiguous.js boundary rule). Rationale: the
calendar "team" shipped only a stale assistant-chat script, standing up
a second HTTP hop buys nothing at hackathon scale, and the verified
endpoint list in SHARED_MEMORY is short. CALENDAR.md stays authoritative
for the TimeWindow/CalendarEvent shapes the agent uses internally.

WORK ITEMS, IN ORDER
--------------------

1. bus/ skeleton and intake.

   POST /webhooks/inbound (the subscription target messaging/ fans out
   to): validate against phone-contract.inboundMessage, dedup on
   externalId (fanout is at-least-once -- providers retry and our own
   dedup is in-memory), return 202, hand off to the loop async. Never
   block the sender on the LLM or Ambiguous.

   GET /healthz reports messaging and Ambiguous reachability.

   Wiring: set UPSTREAM_URL on the messaging service, or POST
   /subscriptions {url: "{AGENT_BASE_URL}/webhooks/inbound"} at startup.
   Subscribe before traffic -- fanout is fire-and-forget, missed
   deliveries only exist in messaging's GET /messages log.

2. State.

   In-memory maps keyed by threadKey: conversation state, jobs,
   customers. Persist to one JSON file on mutation so a restart mid-demo
   does not lose a half-finished booking. No database -- KISS. The
   shapes are the schemas committed in models/.

   Dedup needs a seen-set like messaging's (cap ~5000). The AgentAction
   log doubles as the demo's audit trail and retry ledger.

3. The loop: intent -> tools -> reply.

   Deterministic intents first, LLM second. The four demo flows in
   docs/GOAL.md are few and phrased predictably ("what's my day",
   "running 20 late", "can you come Thursday", "cancel"). A small intent
   classifier gets the demo guaranteed-working without an LLM key or
   latency. An LLM pass (OPENAI_API_KEY/ANTHROPIC_API_KEY -- we hold it,
   per INTERFACES.md) is the fallback for unclassified messages, calling
   the same tools. Do not lead with the LLM; a regex that always works
   beats a model that mostly works in a 4-minute demo.

   Tools per docs/API.md, thin wrappers over bus/ambiguous.js:
   get_availability, book_job, reschedule_job, cancel_job,
   get_schedule, find_customer, upsert_customer, notify, report_delay.
   Every tool call lands in the AgentAction log; tool failure becomes a
   plain-language "couldn't reach the calendar, try again in a minute"
   -- the loop never throws at the user.

4. The four flows (the MVP per GOAL.md).

   WHAT'S MY DAY: get_schedule(today) -> one short text. Contractor
   identified by phone matching CONTRACTOR phone in config.

   BOOKING: inbound from unknown number -> upsert_customer ->
   get_availability -> propose ONE concrete slot, never a list -> on
   "yes" book_job -> confirmations to client and contractor. Pending
   proposals are per-thread state; "yes" resolves against the last
   proposal.

   RUNNING LATE: "running 20 late" from the contractor ->
   report_delay(20): shift the current/next event, text the affected
   client the new ETA, confirm to the contractor.

   CANCEL/RESCHEDULE: either party -> cancel_job or reschedule_job ->
   counterparty notified; a cancel offers rebooking in the same text.

5. Daily digest.

   POST /internal/digest -> get_schedule(today) -> one formatted text to
   the contractor. Manual trigger first (curl for the demo); a setInterval
   morning cron is a one-liner once the trigger works.

6. Inbound transports (messaging/ side, as hardware allows).

   Outbound is covered three ways (sim, ambimail, BlueBubbles); real
   INBOUND is the gap. LoopMessage: real iMessage without a Mac;
   sandbox is inbound-initiated with a 24h reply window -- every demo
   phone must text in once before we can reach it. Twilio SMS: last
   resort, trial prefixes outbound and verified-numbers-only. Each is a
   transport in transports.js plus a webhook route in index.js; the
   normalized contract does not change. Only build the one the venue's
   hardware actually needs.

6b. Proactive client schedule push (planned).

   Inbound reschedule works -- a client can text "move it" and get open
   slots. Missing: an outbound trigger that texts a client their current
   booking plus the reschedule offer without them asking. Shape: POST
   /internal/client-update {phone?} -> for each confirmed future job
   (or the given client's), text "You have <job> <day> at <time>. Reply
   with a new day/time to move it." Reuses store job records + fmtDay/
   fmtTime; the reply re-enters through the existing reschedule intent,
   so no new state machine. Scheduling cadence (e.g. day-before auto
   send) is a reminder-tick extension once the trigger exists.

7. Voice (shipped as a seam).

   POST /voice/turn is the synchronous endpoint the voice layer calls:
   in {from, body}, out {reply} to speak. The caller's reply is spoken,
   not texted; counterparty notifications still go out over messaging.
   A Vapi tool-call or the frontend JS both map onto it. Contract in
   docs/bus.md.

DECISIONS AND WHY
-----------------

Agent calls Ambiguous directly. A separate calendar service is the
INTERFACES.md ideal; at hackathon scale it is a hop with no second
implementer. If a calendar service ever lands, bus/ambiguous.js is
the only file that changes.

Deterministic intents before LLM -- revised in place. The shipped
classifier is Ambiguous assistant/chat asked for a JSON intent (bus/
ai.js); it always returns a valid shape because failures fall back to
{intent:"other"}. The regex layer turned out unnecessary once
assistant/chat proved live and fast, and one path is simpler than two.
If assistant/chat ever degrades, a deterministic pre-pass can be added
in ai.js without touching the loop.

JSON file state, not a database. One contractor, a handful of jobs,
four hours. The file exists so restarts do not wipe a pending booking.

Dedup on both sides. messaging/ dedups before fanout; the agent dedups
again on receipt. In-memory dedup loses to a restart; providers retry.

One slot, not a list -- revised in place. The shipped flow offers up to
three open times and accepts "1", "second", or "9am works" as the pick.
A single proposed slot forced a re-ask on every conflict; three options
book in one round-trip and still read like a person texting.

ENV REGISTRY (agent service, as shipped)
----------------------------------------

  PORT                  where it listens (default 4010)
  PUBLIC_URL            its reachable URL, used for the subscription
  MESSAGING_URL         the messaging service (== PHONE_SERVICE_URL)
  AMBIG_API             ak_ key for etai-workspace (unset -> stub)
  CONTRACT_PHONE        E.164; identifies "the boss" texts
  CONTRACTOR_TZ         IANA timezone for slot math
  STATE_FILE            JSON persistence path
  REMINDER_LEAD_MINUTES heads-up window for reminders.js

VERIFYING
---------

Root `npm test` on every commit (the .githooks hook). New agent tests go
in bus/tests/*.test.js to match the glob. Contract-critical paths get
tested: inbound dedup, intent classification of the demo phrases, slot
proposal, job status transitions, the send-validation boundary.

End to end without hardware: run messaging/ (sim transport), run bus/
with UPSTREAM_URL-style subscription, POST /simulate/inbound a demo
phrase, watch the reply arrive via the sim transport's stdout and the
event land in the Ambiguous web UI.

Frontend is untouched by this workstream; `npm --prefix frontend test`
still has to pass for anyone editing it.

OPEN QUESTIONS
--------------

  - RESOLVED: assistant/chat is live and is the intent classifier
    (bus/ai.js). It answers wrapped JSON reliably; failures fall back
    to {intent:"other"}. notify() and thread state stayed ours.
  - Whether the commit hook should also run the frontend suite -- it
    currently does not (core.hooksPath=.githooks runs only root
    npm test; scripts/pre-commit.sh was never installed into .git/hooks
    and would be bypassed anyway).
  - Who texts first in the demo if we land on LoopMessage (inbound-
    initiated only) -- script the order accordingly.
