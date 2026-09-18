FRONTEND -- the call-your-agent web app
========================================

frontend/ is a React + Vite app that drops you straight into a
FaceTime-style call with the etAI persona (src/agents.js). Each user
turn goes to the service: voiceTurn() in src/api/bus.js posts
VITE_BUS_URL/voice/turn and the reply is what the agent speaks. The
caller is VITE_DEMO_PHONE so the call shares one thread with SMS -
same intents, bookings, CRM sync, notifications. When the service is
unreachable the agent says so; there is no in-browser scheduling
fallback, so a booking can never diverge from the service calendar.

The dispatch board (App.jsx) reads GET /state via fetchBoard() and
calendar events + CRM contacts via fetchCalendarJobs() in
src/api/ambiguous.js - the only frontend file that fetches Ambiguous.
On hang up, sendConversation() stores the transcript as a workspace
document.

AgentSurface renders public/map-pin-marker.riv (vendored, 2.9 KB) via
@rive-app/react-canvas; its `isSelecting` boolean binds to `speaking`,
so the pin lifts while the agent talks. The orb stays mounted behind
the canvas as the load fallback.

RUN
---

  npm --prefix frontend install
  npm run dev

  VITE_AMBIGUOUS_API_KEY   calendar/contacts for the board, transcripts
  VITE_BUS_URL             service base for /voice/turn, /state, /tts
  VITE_MESSAGING_URL       same service; board SMS button via /send
  VITE_DEMO_PHONE          reroutes outbound texts to the demo number

Verify changes with `npm run build` and `npm --prefix frontend test`
(80 percent coverage thresholds on src/api + src/lib).
