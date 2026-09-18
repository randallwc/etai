FRONTEND -- the call-your-agent web app
========================================

frontend/ is a React + Vite app that drops you straight into a
FaceTime-style call with the etAI persona (the AGENT object in
App.jsx). Each user turn goes to the service: voiceTurn() in
CallScreen.jsx posts VITE_BUS_URL/voice/turn and the reply is what
the agent speaks via speechSynthesis. The caller is VITE_DEMO_PHONE
so the call shares one thread with SMS - same intents, bookings, CRM
sync, notifications. When the service is unreachable the agent says
so; there is no in-browser scheduling fallback, so a booking can
never diverge from the service calendar.

On hang up, sendConversation() in src/api/ambiguous.js stores the
transcript as a workspace document - the only Ambiguous call the
frontend makes.

AgentSurface renders public/map-pin-marker.riv (vendored, 2.9 KB) via
@rive-app/react-canvas; its `isSelecting` boolean binds to `speaking`,
so the pin lifts while the agent talks. The orb stays mounted behind
the canvas as the load fallback.

RUN
---

  npm --prefix frontend install
  npm run dev

  VITE_AMBIGUOUS_API_KEY   transcript handoff documents
  VITE_BUS_URL             service base for /voice/turn
  VITE_DEMO_PHONE          the caller identity sent on every turn

Verify changes with `npm run build` and `npm --prefix frontend test`
(80 percent coverage thresholds on src/api).
