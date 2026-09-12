# ETAi

**AI Tinkerers Seattle Hackathon 2026** · [Hackathon page](https://seattle.aitinkerers.org/hackathons/h_GfcjwcUkasM/teams) · [Ambiguous.ai](https://app.ambiguous.ai/settings)

## mvp

1. calendar - create, cancel, update
1. notifications - late, cancellation, daily schedule
1. messages

## stretch goals

1. imessage
1. phone call - ai voice
1. weather
1. maps & travel time
1. ui with eta and location think uber for the client
1. allow contractor to ask the agent to order parts and then have the agent dedicate time in the schedule for going to the clients job site again for work.
1. prioritization for meetings

## tenets

1. no chat
1. ai uses tools
1. solves problem people have that are not technical

## What we're building

A web app that lets users **call / FaceTime their personal AI agent** for a quick,
human-feeling conversation. The agent has a short chat with the user, then hands
the structured result to **Ambiguous.ai**, which handles scheduling and planning
afterwards.

## The flow

```
User texts or calls the agent
        │
        ▼
Agent greets and asks:
  "Do you want a day summary, or add a new task?"
        │
        ├── Day summary ──► agent reads back today's plan
        │
        └── New task ──► user describes it (voice/text)
                          │
                          ▼
              Conversation is packaged and sent
              to Ambiguous.ai for scheduling & planning
```

## Key ideas

- **Personas**: every agent is different — different name, voice, color theme,
  and visual treatment. Agents feel human, not like a generic chatbot.
- **Video-first**: the call UI shows the user's camera next to the agent's
  video surface. For the hackathon the agent side is a live animated avatar;
  visual interpolation / real generated video is a future milestone.
- **Voice now, visuals later**: today the user talks (or types) to the agent.
  The interface is designed so a real avatar stream can drop in later without
  restructuring the app.

## Repo layout

```
/
├── README.md            ← you are here
├── AGENTS.md            ← conventions & guidelines for coding agents
├── frontend/            ← React (Vite) app — the call interface
│   └── src/api/ambiguous.js   ← Ambiguous.ai integration layer
└── (backend lives at the root as it's built)
```

## Quick start

```bash
cd frontend
npm install
cp .env.example .env.local   # add your Ambiguous API key (optional)
npm run dev
```

Open the printed localhost URL — the app drops you straight into a
FaceTime-style call. Grant camera/mic permission when prompted.

### Connecting Ambiguous.ai

1. Get an API key (`ak_...`) at https://app.ambiguous.ai/admin
2. Put it in `frontend/.env.local` as `VITE_AMBIGUOUS_API_KEY`
3. Restart the dev server

With a key set, the app pulls **your real Ambiguous coworkers** as the
callable agents, reads your day summary from Calendar/Tasks, creates tasks
via `POST /api/tasks`, and auto-sends the call transcript to the Assistant
on hang up. Without a key it runs on local fallback personas — same UI.

## Roadmap

- [x] Call UI with user video + per-persona agent surface
- [x] Day-summary / new-task prompt flow
- [x] Ambiguous.ai integration layer (coworkers, tasks, calendar, handoff)
- [ ] Verify live API shapes against a real key
- [ ] Real speech-to-text / text-to-speech
- [ ] Animated agent video (visual interpolation)
- [ ] Auth + per-user agent persistence
