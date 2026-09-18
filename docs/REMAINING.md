REMAINING -- open work
======================

  1. /tts returns 503: msedge-tts is lazily required but not in
     package.json. Add the dependency or drop the endpoint before a
     demo that plays audio.

  2. frontend/.env.local is missing (VITE_AMBIGUOUS_API_KEY,
     VITE_BUS_URL) -- the dispatcher board and call path need it.

  3. ALLOWED_FROM filters inbound to the demo phone. CONTRACT_PHONE is
     the same number today, so contractor texts still get through --
     the moment the contractor uses another phone they are filtered
     too. Either allowlist both numbers or drop the filter.

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
     copilot-sms-imessage branch. Recover from git history if the loop
     ever needs a richer agent runtime.
