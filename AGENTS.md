# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.
Read this file fully before making changes. When it conflicts with a
guess, this file wins.

## 0. Hackathon theme

Agents are leaving the chatbox. Build an agent for a place people
already work, talk, or live, then make it meaningfully more useful
because of that context. Put it into the web, mobile, Slack, Teams,
messaging, browsers, voice, wearables, robotics, or somewhere nobody
expects to find one yet. What becomes possible when the agent shows up
where the work is already happening?

---

## 1. Engineering rules

1. No comments in code. Docstrings only on external, well-named
   functions.
1. Never use em dashes. Use single hyphens when punctuation needs a dash.
   Keep sentences plain English, short, and to the point.
1. Delete stale code and docs when replacing a flow.
1. Keep one source of truth per feature. Update or remove conflicting docs
   in the same change.
1. Keep README focused on what runs now. Move history and rejected ideas
   into a short decision log.
1. For changes, report only changed files, verification run, and known
   limitation.
1. Avoid filler terms such as “robust,” “seamless,” “comprehensive,”
   “leverages,” and “future-proof.”
1. Every new file needs a named owner and a reason it cannot fit an
   existing file.
1. Prefer concrete acceptance criteria over vague product language.
1. Always pull with rebase before pushing. Use autostash when the worktree
   has other agents' changes, then resolve any restore conflicts without
   changing their work.
1. Always create a schema before writing code and commit it first,
   under `models/`.
1. Keep documents in `./docs`, unix format, no tables. Prose summaries
   of each external part; document gotchas and tried-and-rejected
   approaches so others can learn.
1. Never over-engineer. KISS - ponytail rules (adapted from
   github.com/dietrichgebert/ponytail). Lazy senior dev: the best code
   is the code never written. Before writing code, stop at the first
   rung that holds: does this need to exist at all (speculative need =
   skip it, say so in one line); already in this codebase (reuse the
   helper or pattern - look before you write); stdlib does it; native
   platform feature covers it (`input[type=date]` over a picker lib,
   css over js, db constraint over app code); installed dependency
   solves it (never add a new one for what a few lines can do); one
   line; only then the minimum code that works. The ladder runs after
   you understand the problem, not instead of it - read the code the
   change touches and trace the real flow first. Bug fix = root cause,
   not symptom: grep every caller of the function you touch; one guard
   in the shared function beats a guard per caller. No unrequested
   abstractions (no interface with one impl, no factory for one
   product, no config for a constant). No boilerplate or scaffolding
   for later. Deletion over addition. Boring over clever. Fewest files
   possible. Two same-size options: take the one correct on edge cases.
   A deliberate simplification with a known ceiling (global lock, O(n²)
   scan, naive heuristic) gets named in the commit message or docs with
   its upgrade path - rule 1 still bans the comment. Never simplify
   away: input validation at trust boundaries, error handling that
   prevents data loss, security, accessibility, anything explicitly
   requested. User insists on the full version: build it.
1. Commits: one-line heading plus 2-3 sentences. Keep details in
   `./docs`.
1. Outbound texts are copy, not UI. One or two short sentences, single
   hyphens, no lists or numbering. Offer choices inline ("I have 9:00 AM,
   11:00 AM, or 1:00 PM open Fri. Which works?"); replies still parse as
   number, ordinal, or time. The persona name appears only in the
   greeting - never brand a reply.
1. Tests: up to 80% line and branch coverage per commit, enforced by a
   git hook that runs tests on commit creation. Do not over-test or
   split code just to hit the number; test shared things more.

## 2. Project mission

A **call-your-agent** web app on top of Ambiguous.ai. The user opens the
app and is immediately in a FaceTime-style call with a personal agent.
The agent offers a day summary or takes requests - scheduling requests
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
├── models/                    JSON Schemas for every data shape - schema
│                              first, before code that touches it.
│                              Tests in models/tests/ validate all files.
├── docs/                      prose documentation, unix format, no tables
├── scripts/pre-commit.sh      frontend vitest runner (see hook note below)
├── messaging/                 phone service: POST /send out, normalized
│   │                          inbound fanout to subscribers, BlueBubbles +
│   │                          sim transports. Contract: docs/PHONE.md,
│   │                          run notes: docs/messaging.md
│   └── tests/
├── Makefile                   delegates to per-component Makefiles
├── calendar-agent/            Ambiguous Assistant chat smoke script
│   └── tests/
├── bus/                     the agent core - texts and voice turns
│   │                          in, Ambiguous calls, replies out.
│   │                          Docs: docs/bus.md
│   ├── index.js               HTTP + wiring (createBusServer)
│   ├── loop.js                intent -> calendar tools -> reply
│   ├── ai.js                  assistant/chat intent classification
│   ├── calendar.js            calendar adapter + stub fallback
│   ├── state.js               threads/jobs/customers/dedup/action log
│   ├── reminders.js           pre-job heads-up texts
│   ├── ambiguous.js           THE backend Ambiguous boundary
│   └── tests/
├── shared/                    zero-dep helpers shared across services
│   └── env.js                 .env loader (no override of set vars)
├── bus/                       central router: /webhooks/inbound forwards
│                              to calendar AI, /webhooks/calendar takes
│                              notifications -> texts via messaging /send
├── user-interface/            reserved, empty (frontend/ is the real UI)
└── frontend/                  React + Vite app (self-contained deployable)
    ├── index.html
    ├── package.json
    ├── vite.config.js
    ├── vitest.config.js       coverage thresholds: 80% on src/api + src/lib
    ├── .env.local             VITE_AMBIGUOUS_API_KEY (gitignored)
    └── src/
        ├── main.jsx           entry point
        ├── App.jsx            console shell: board, job detail, call overlay
        ├── agents.js          the single etAI persona
        ├── styles.css         all styling, CSS custom properties
        ├── api/ambiguous.js   THE Ambiguous boundary - only file with fetch
        ├── lib/parseRequest.js request classification, done-detection,
        │                      offline replies
        ├── lib/schedule.js    free/busy slot math, time formatting
        └── components/
            ├── CallScreen.jsx     call UI + conversation state machine
            └── AgentSurface.jsx   full-screen agent visual (Rive pin)
```

## 4. Commands

Every component has a Makefile; the root one delegates (`make test`,
`make run-messaging`, `make run-bus`, `make frontend-build`,
`make frontend-test`, `make -C <dir> test`).

Root tests (backend, node:test): `npm test` from repo root - the glob is
`'*/tests/*.test.js'`; `node --test <dir>` does not discover tests.
Messaging service: `make run-messaging` (PORT, default 4020)
Bus service: `make run-bus` (PORT, default 4010)
Calendar smoke script: `npm run test:calendar` (needs AMBIGUOUS_API_KEY)
Install deps: `cd frontend && npm install`
Dev server: `cd frontend && npm run dev`
Build: `cd frontend && npm run build`
Frontend tests: `cd frontend && npm test`
Ambiguous CLI: `npx ambiguous@latest catalog` (from repo root - uses
./.ambi/config.json)

Verify any backend change with root `npm test`; verify any frontend
change with `npm run build` and `npm test` before considering it done.
Note: the commit hook runs only root `npm test` - run the frontend
suite yourself before committing frontend changes.

## 5. Sub-agent roles

When parallelizing work, split along these boundaries. Each role owns its
files exclusively - never let two agents edit the same file.

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

### 5.4 Media / Voice Agent
Owns the agent visual surface and audio I/O: the orb (or video later),
mic to STT, TTS to speaker, and the phone-call layer. For call
intelligence, do NOT rebuild scheduling logic - POST each caller turn
to the agent service's `POST /voice/turn` ({from, body} -> {reply} to
speak); notifications to the other party go out over messaging
automatically. Contract in docs/bus.md. Keep `AgentSurface`'s props
(`agent`, `speaking`) stable.

### 5.5 Messaging / Phone Agent
Owns `messaging/` - the phone service behind the docs/PHONE.md
contract. Transports (BlueBubbles, sim, ambimail, LoopMessage/Twilio if
added) live in `transports.js`; normalization in `normalize.js`;
fanout/dedup in `index.js`. Invariant: subscribers only ever see the
normalized inboundMessage shape; transport detail never crosses the
boundary.

### 5.6 Agent Core Agent
Owns `bus/` (docs/bus.md). Consumes normalized inbound from the
messaging service and voice turns via POST /voice/turn, owns per-thread
state and the data model (models/*.schema.json), classifies intent via
bus/ai.js, calls Ambiguous through its own `bus/ambiguous.js`
client, replies via messaging POST /send (or in the voice response
body). Never touches a transport directly. The Ambiguous boundary rule
applies here too: one file fetches Ambiguous.

## 6. Architecture rules

1. Small state, one owner. `App.jsx` owns the dispatch board and the
   call overlay. `CallScreen.jsx` owns the call phase machine:
   connecting, live, sending, done.
2. Personas are data, not code. The roster is a single etAI persona
   from `agents.js`; `fetchCoworkers` stays in the api boundary if a
   multi-agent roster ever returns. Never hardcode a persona inside a
   component.
3. The Ambiguous boundary is explicit: `src/api/ambiguous.js` is the only
   frontend file that calls fetch. The backend twin is
   `bus/ambiguous.js` once the agent core lands. Offline mode must
   keep the app working end-to-end.
4. Media is behind a seam. `AgentSurface` renders whatever visual the
   persona defines; the orb today, a video stream later.
5. Graceful degradation. Camera denied means a placeholder tile and the
   user continues by text.

## 7. Ambiguous.ai reference

Full details live in docs/ambiguous-integration.md - verified endpoint
shapes, gotchas (provisional workspace blocks provisioning until the
human verifies; coworkers dispatch needs a service id that only
persona-backed coworkers have), and approaches we tried and rejected.
Read it before touching src/api/.

## 8. Definition of done

Root `npm test` passes (runs on every commit via .githooks). For
frontend work: `npm run build` and `npm test` pass, and the connecting,
live, sending, done flow still works end-to-end including re-dial and
mid-call switching. Personas render distinctly. The Ambiguous boundary
stays in `src/api/ambiguous.js` (frontend) and `bus/ambiguous.js`
(backend). No secrets, no dead code.
