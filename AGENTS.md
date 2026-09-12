# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.
Read this file fully before making changes. When it conflicts with a
guess, this file wins. AGENT.md holds the team's engineering rules; this
file holds the project map.

---

## 1. Project mission

A **call-your-agent** web app on top of Ambiguous.ai. The user opens the
app and is immediately in a FaceTime-style call with a personal agent.
The agent offers a day summary or takes requests — scheduling requests
book real calendar events after checking free/busy availability; other
requests become tasks. On hang up, the full transcript is stored in the
workspace as a document so coworkers can validate what was agreed.

Every agent has a distinct persona: name, role, theme color, greeting.
The call UI is the agent's full-screen visual plus the user's camera in a
draggable picture-in-picture tile.

## 2. Repository layout

```
/
├── README.md
├── AGENTS.md                  this file
├── AGENT.md                   team engineering rules
├── LICENSE
├── models/                    JSON Schemas for every data shape — schema
│                              first, before code that touches it
├── docs/                      prose documentation, unix format, no tables
├── scripts/pre-commit.sh      test runner installed as a git hook
└── frontend/                  React + Vite app (self-contained deployable)
    ├── index.html
    ├── package.json
    ├── vite.config.js
    ├── vitest.config.js       coverage thresholds: 80% on src/api + src/lib
    ├── .env.local             VITE_AMBIGUOUS_API_KEY (gitignored)
    └── src/
        ├── main.jsx           entry point
        ├── App.jsx            loads coworkers, holds selected agent
        ├── agents.js          local fallback personas (offline mode)
        ├── styles.css         all styling, CSS custom properties
        ├── api/ambiguous.js   THE Ambiguous boundary — only file with fetch
        ├── lib/parseRequest.js request classification, done-detection,
        │                      offline replies
        ├── lib/schedule.js    free/busy slot math, time formatting
        └── components/
            ├── CallScreen.jsx     call UI + conversation state machine
            └── AgentSurface.jsx   full-screen agent visual (orb today)
```

## 3. Commands

Install deps: `cd frontend && npm install`
Dev server: `cd frontend && npm run dev`
Build: `cd frontend && npm run build`
Tests: `cd frontend && npm test`
Ambiguous CLI: `npx ambiguous@latest catalog` (from repo root — uses
./.ambi/config.json)

Verify any frontend change with `npm run build` and `npm test` before
considering it done.

## 4. Sub-agent roles

When parallelizing work, split along these boundaries. Each role owns its
files exclusively — never let two agents edit the same file.

### 4.1 Frontend UI Agent
Owns `frontend/src/components/` and `frontend/src/styles.css`. Builds the
call interface: agent surface, camera PiP, captions, controls, persona
theming. Does not touch state flow in `CallScreen` without coordinating
with the conversation role.

### 4.2 Persona / Conversation Agent
Owns `frontend/src/agents.js`, `frontend/src/lib/parseRequest.js`, and the
dialogue flow inside `CallScreen`. Personas must feel human: distinct
voice, no generic chatbot phrasing.

### 4.3 Integration Agent
Owns `frontend/src/api/ambiguous.js` and `frontend/src/lib/schedule.js`.
The contract: `fetchCoworkers` (roster from /users), `fetchDaySummary`
(calendar + tasks), `createTask`, `handleRequest` (scheduling and task
routing mid-call), `sendConversation` (transcript handoff). Components
never fetch Ambiguous endpoints directly. Every function degrades
gracefully when no API key is set.

### 4.4 Media Agent (future)
Owns the agent visual surface and audio I/O. Swaps the orb for real
generated video and wires mic to STT, TTS to speaker. The seam is
`AgentSurface` — keep its props (`agent`, `speaking`) stable.

## 5. Architecture rules

1. Small state, one owner. `App.jsx` loads the coworker list and holds
   the selected agent. `CallScreen.jsx` owns the call phase machine:
   connecting, live, sending, done — plus `awaitingTask` for the new-task
   branch.
2. Personas are data, not code. With an API key they come from
   `GET /api/users` (type agent). Without one they come from `agents.js`.
   Never hardcode a persona inside a component.
3. The Ambiguous boundary is explicit: `src/api/ambiguous.js` is the only
   file that calls fetch. Offline mode must keep the app working
   end-to-end.
4. Media is behind a seam. `AgentSurface` renders whatever visual the
   persona defines; the orb today, a video stream later.
5. Graceful degradation. Camera denied means a placeholder tile and the
   user continues by text.

## 6. Conventions

See AGENT.md for the rules: no code comments (docstrings on external
functions only), schema-first under models/, docs in ./docs in unix prose
format, KISS, short commits, 80% test coverage enforced by a git hook.

## 7. Ambiguous.ai reference

Full details live in docs/ambiguous-integration.md — verified endpoint
shapes, gotchas (provisional workspace blocks provisioning until the
human verifies; coworkers dispatch needs a service id that only
persona-backed coworkers have), and approaches we tried and rejected.
Read it before touching src/api/.

## 8. Definition of done

`npm run build` and `npm test` pass. The connecting, live, sending, done
flow still works end-to-end including re-dial and mid-call switching.
Personas render distinctly. The Ambiguous boundary stays in
`src/api/ambiguous.js`. No secrets, no dead code.
