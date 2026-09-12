PLAN -- local messaging integration
====================================

Read with docs/MESSAGING_GOAL.md (the behavior spec), docs/agent.md
(the brain), docs/messaging.md (transports). This file is the punch
list for wiring the remaining pieces into one working text-in /
calendar-action / text-out loop on real phones.

WHAT WORKS TODAY (verified live)
--------------------------------

  - Outbound texts reach real phones: agent -> messaging /send ->
    ambimail (Ambiguous mail.send -> <number>@vtext.com). Body must go
    in body_markdown (and body_text); body_text alone produced empty
    mails -- phones showed "(ETAi)" only.
  - Inbound replies reach the agent: client replies -> carrier gateway
    -> email lands in the Ambiguous workspace inbox -> messaging
    mailpoller (GET /api/mail/inbox?unread=true every MAIL_POLL_SECONDS)
    -> normalized inboundMessage -> fanout to subscribers -> agent
    /webhooks/inbound.
  - The agent loop acts on real replies: assistant/chat classifies the
    intent, loop.js drives propose/book/reschedule/cancel/late against
    the real Ambiguous calendar, replies go back out by text. A real
    client reply ("sounds good, see you then") was received and
    answered.
  - Push alternative for inbound: an Ambiguous webhook on
    email.received is registered to POST /webhooks/ambimail (https URL
    required -- a pinggy/cloudflared tunnel to messaging works). The
    poller needs no public URL and is the reliable demo path.
  - Time triggers exist in two places: agent/reminders.js (per-job
    heads-up to contractor) and calendar-agent/notify.js ->
    bus/webhooks/calendar (Ambiguous's own reminder feed -> contractor
    text).
  - Demo data: scripts/seed-calendar.js seeds 5 jobs; scripts/demo.js
    drives the loop with .env numbers.

THE ONE-BRAIN RULE (integration decision)
-----------------------------------------

bus/ and agent/ both accept POST /webhooks/inbound. bus forwards raw
text to assistant/chat and replies; agent runs the real loop. If BOTH
are subscribed to messaging, every text gets two answers. Rule:

  - messaging /subscriptions -> agent ONLY. The agent is the brain.
  - bus/webhooks/calendar stays -- calendar-agent/notify.js POSTs
    there directly (not via subscription), and bus just texts the
    contractor. bus must NOT be registered as an inbound subscriber.
  - If we keep bus' /webhooks/inbound for demos, it is dead code on
    the live path -- do not subscribe it.

REMAINING WORK, IN ORDER
------------------------

1. Verify the fixed body reaches the phone (sent mail 77b866a2). If
   the phone still shows only "(ETAi)", the gateway is stripping the
   body entirely -- then put the whole message in the subject.
2. End-to-end real test of each trigger in docs/MESSAGING_GOAL.md:
   client book -> pick -> locked in; contractor "running 20 late" ->
   client ETA text; contractor cancel -> client rebook offer; digest;
   reminder heads-up.
3. Open-spot offers: on cancel/move, loop should text affected clients
   alternate slots via proposeSlots using pendingProposal mode
   "reschedule". Spec exists; loop.js needs the offer step.
4. Calendar-notification -> client: bus/webhooks/calendar currently
   texts the contractor only. For reschedule offers it should hand the
   notification to the agent (loop.clientUpdate exists) so the right
   client gets offered new times -- or let agent poll the same feed.
   Decide ONE owner; do not double-notify.
5. Startup checklist (demo): messaging :4020 (ambimail + mailpoller),
   agent :4030 subscribed, bus :4010 optional, calendar-agent notify
   optional, seed-calendar run. All load .env via shared/env.js.
6. iMessage remains BlueBubbles-on-a-Mac; everything above works over
   SMS-grade texts today.

GOTCHAS LEARNED
---------------

  - Ambiguous webhooks require https URLs; http://IP is rejected.
  - mail/send silently ignores unknown body fields -- verify stored
    body_markdown/body_html, not just a 200.
  - Carrier gateway replies come from <number>@vtext.com AND
    vzwpix.com (MMS flavor) and other hosts -- normalize.js keeps a
    gateway list; 10-digit local parts become +1<number>.
  - Poller marks mail read (PATCH {read:true}); debugging a live reply
    after the fact means checking state.json/actions, not the inbox.
