# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.
Read this file fully before making changes. When it conflicts with a
guess, this file wins.

---

## 1. Engineering rules

1. No comments in code. Docstrings only on external, well-named
   functions.
1. Always create a schema before writing code and commit it first,
   under `models/`.
1. Keep documents in `./docs`, unix format, no tables. Prose summaries
   of each external part; document gotchas and tried-and-rejected
   approaches so others can learn.
1. Never over-engineer. KISS.
1. Commits: one-line heading plus 2-3 sentences. Keep details in
   `./docs`.
1. Tests: up to 80% line and branch coverage per commit, enforced by a
   git hook that runs tests on commit creation. Do not over-test or
   split code just to hit the number; test shared things more.

## 2. Project mission

A **call-your-agent** web app on top of Ambiguous.ai. The user opens the
app and is immediately in a FaceTime-style call with a personal agent.
The agent offers a day summary or takes requests — scheduling requests
book real calendar events after checking free/busy availability; other
requests become tasks. On hang up, the full transcript is stored in the
workspace as a document so coworkers can validate what was agreed.

Every agent has a distinct persona: name, role, theme color, greeting.
The call UI is the agent's full-screen visual plus the user's camera in a
draggable picture-in-picture tile.

## 3. Repository layout

```
/
├── README.md
├── AGENTS.md                  this file
├── SHARED_MEMORY.md           live state + landmines for all agents
├── FAISAL_MEMORY.md           Devin's machine/repo notes
├── LICENSE
├── package.json               root test script: node --test '*/tests/*.test.js'
├── .githooks/pre-commit       runs root npm test (core.hooksPath=.githooks)
├── models/                    JSON Schemas for every data shape — schema
│                              first, before code that touches it.
│                              Tests in models/tests/ validate all files.
├── docs/                      prose documentation, unix format, no tables
├── scripts/pre-commit.sh      frontend vitest runner (see hook note below)
├── messaging/                 phone service: POST /send out, normalized
│   │                          inbound fanout to subscribers, BlueBubbles +
│   │                          sim transports. Contract: docs/PHONE.md,
│   │                          run notes: docs/messaging.md
│   └── tests/
├── calendar-agent/            Ambiguous Assistant chat smoke script
│   └── tests/                 (assistant/chat status disputed — see
│                              SHARED_MEMORY landmines)
├── agent/                     (planned) the agent core — see
│                              docs/messaging-plan.md
├── shared/                    zero-dep helpers shared across services
│   └── env.js                 .env loader (no override of set vars)
├── bus/                       reserved, empty
├── user-interface/            reserved, empty (frontend/ is the real UI)
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

## 4. Commands

Root tests (backend, node:test): `npm test` from repo root — the glob is
`'*/tests/*.test.js'`; `node --test <dir>` does not discover tests.
Messaging service: `node messaging/index.js` (PORT, default 4020)
Calendar smoke script: `npm run test:calendar` (needs AMBIGUOUS_API_KEY)
Install deps: `cd frontend && npm install`
Dev server: `cd frontend && npm run dev`
Build: `cd frontend && npm run build`
Frontend tests: `cd frontend && npm test`
Ambiguous CLI: `npx ambiguous@latest catalog` (from repo root — uses
./.ambi/config.json)

Verify any backend change with root `npm test`; verify any frontend
change with `npm run build` and `npm test` before considering it done.
Note: the commit hook runs only root `npm test` — run the frontend
suite yourself before committing frontend changes.

## 5. Sub-agent roles

When parallelizing work, split along these boundaries. Each role owns its
files exclusively — never let two agents edit the same file.

### 5.1 Frontend UI Agent
Owns `frontend/src/components/` and `frontend/src/styles.css`. Builds the
call interface: agent surface, camera PiP, captions, controls, persona
theming. Does not touch state flow in `CallScreen` without coordinating
with the conversation role.

### 5.2 Persona / Conversation Agent
Owns `frontend/src/agents.js`, `frontend/src/lib/parseRequest.js`, and the
dialogue flow inside `CallScreen`. Personas must feel human: distinct
voice, no generic chatbot phrasing.

### 5.3 Integration Agent
Owns `frontend/src/api/ambiguous.js` and `frontend/src/lib/schedule.js`.
The contract: `fetchCoworkers` (roster from /users), `fetchDaySummary`
(calendar + tasks), `createTask`, `handleRequest` (scheduling and task
routing mid-call), `sendConversation` (transcript handoff). Components
never fetch Ambiguous endpoints directly. Every function degrades
gracefully when no API key is set.

### 5.4 Media Agent (future)
Owns the agent visual surface and audio I/O. Swaps the orb for real
generated video and wires mic to STT, TTS to speaker. The seam is
`AgentSurface` — keep its props (`agent`, `speaking`) stable.

### 5.5 Messaging / Phone Agent
Owns `messaging/` — the phone service behind the docs/PHONE.md
contract. Transports (BlueBubbles, sim, ambimail, LoopMessage/Twilio if
added) live in `transports.js`; normalization in `normalize.js`;
fanout/dedup in `index.js`. Invariant: subscribers only ever see the
normalized inboundMessage shape; transport detail never crosses the
boundary.

### 5.6 Agent Core Agent
Owns `agent/` (planned — docs/messaging-plan.md). Consumes normalized
inbound from the messaging service, owns per-thread state and the data
model (models/*.schema.json), decides intent, calls Ambiguous through
its own `agent/ambiguous.js` client, replies via POST /send. Never
touches a transport directly. The Ambiguous boundary rule applies here
too: one file fetches Ambiguous.

## 6. Architecture rules

1. Small state, one owner. `App.jsx` loads the coworker list and holds
   the selected agent. `CallScreen.jsx` owns the call phase machine:
   connecting, live, sending, done — plus `awaitingTask` for the new-task
   branch.
2. Personas are data, not code. With an API key they come from
   `GET /api/users` (type agent). Without one they come from `agents.js`.
   Never hardcode a persona inside a component.
3. The Ambiguous boundary is explicit: `src/api/ambiguous.js` is the only
   frontend file that calls fetch. The backend twin is
   `agent/ambiguous.js` once the agent core lands. Offline mode must
   keep the app working end-to-end.
4. Media is behind a seam. `AgentSurface` renders whatever visual the
   persona defines; the orb today, a video stream later.
5. Graceful degradation. Camera denied means a placeholder tile and the
   user continues by text.

## 7. Ambiguous.ai reference

Full details live in docs/ambiguous-integration.md — verified endpoint
shapes, gotchas (provisional workspace blocks provisioning until the
human verifies; coworkers dispatch needs a service id that only
persona-backed coworkers have), and approaches we tried and rejected.
Read it before touching src/api/.

## 8. Definition of done

Root `npm test` passes (runs on every commit via .githooks). For
frontend work: `npm run build` and `npm test` pass, and the connecting,
live, sending, done flow still works end-to-end including re-dial and
mid-call switching. Personas render distinctly. The Ambiguous boundary
stays in `src/api/ambiguous.js` (frontend) and `agent/ambiguous.js`
(backend). No secrets, no dead code.
