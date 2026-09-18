FRONTEND -- the call-your-agent web app
========================================

WHAT IT IS
----------

A web app (frontend/, React + Vite) that lets users call or FaceTime
their personal AI agent for a quick, human-feeling conversation. The
agent has a short chat with the user, then hands the structured result
to Ambiguous.ai, which handles scheduling and planning afterwards.

The app drops you straight into a FaceTime-style call. Grant camera and
mic permission when prompted.

THE FLOW
--------

    User texts or calls the agent
            |
            v
    Agent greets and listens:
      rescheduling, booking, status updates, tasks
            |
            v
    User says what they need (voice/text)
            |
            v
    Each turn goes to the service
    (POST /voice/turn via src/api/bus.js)
            |
            v
    Conversation is packaged and sent
    to Ambiguous.ai for scheduling & planning

KEY IDEAS
---------

Personas: every agent is different -- name, voice, color theme, visual
treatment. Agents feel human, not like a generic chatbot. With an API
key they come from the Ambiguous workspace roster (GET /api/users, type
"agent"); without one they come from frontend/src/agents.js.

Video-first: the call UI shows the user's camera next to the agent's
video surface. For the hackathon the agent side is a live animated
avatar; visual interpolation and real generated video are future
milestones.

Voice now, visuals later: today the user talks or types to the agent.
The interface is designed so a real avatar stream can drop in later
without restructuring the app.

RUNNING IT
----------

    cd frontend
    npm install
    cp .env.example .env.local   # add your Ambiguous API key (optional)
    npm run dev

Open the printed localhost URL.

Verify any change with `npm run build` and `npm test` before calling it
done -- coverage thresholds (80 percent on src/api and src/lib) are
enforced by vitest config and the pre-commit hook.

CONNECTING AMBIGUOUS.AI
-----------------------

  1. Get an API key (ak_...) at https://app.ambiguous.ai/admin
  2. Put it in frontend/.env.local as VITE_AMBIGUOUS_API_KEY
  3. Restart the dev server

With a key set, the app pulls the real Ambiguous coworkers as callable
agents, reads the day summary from Calendar/Tasks, creates tasks via
POST /api/tasks, and stores the call transcript as a workspace document
on hang up. Without a key it runs on local fallback personas -- same
UI.

CALL PATH VIA THE SERVICE
-------------------------

When VITE_BUS_URL is set, each user turn in a call goes to
voiceTurn({ from, body }) in src/api/bus.js, which posts to the
service's POST /voice/turn and returns the reply text the agent
speaks. The caller is identified by VITE_DEMO_PHONE (default
+15550000001), so the whole call shares one thread with the same
intents, bookings, CRM sync, and contractor notifications as SMS.
When VITE_BUS_URL is unset or the request fails, voiceTurn returns
null and the agent says it cannot reach the service -- there is no
in-browser scheduling fallback, so a booking can never silently diverge
from the service's calendar.

ROADMAP
-------

Done:

  - Call UI with user video + per-persona agent surface
  - Freeform request flow (summary, task, scheduling) via text/voice
  - Ambiguous.ai integration layer (calendar jobs, transcript handoff)
  - Call turns routed through the service voice endpoint when
    VITE_BUS_URL is set (see docs/messaging.md)

Not yet:

  - Verify live API shapes against a real key
  - Real speech-to-text / text-to-speech
  - Animated agent video (visual interpolation)
  - Auth + per-user agent persistence

SEE ALSO
--------

docs/ambiguous-integration.md -- verified endpoint shapes and gotchas.
AGENTS.md                     -- component map and repo rules.
docs/messaging.md             -- the service the ui talks to.
