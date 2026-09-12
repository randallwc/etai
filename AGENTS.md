# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.
Read this file fully before making changes. When it conflicts with a guess,
this file wins.

---

## 1. Project mission

We are building a **call-your-agent** web app on top of
[Ambiguous.ai](https://app.ambiguous.ai/settings):

1. User opens the app and is immediately in a FaceTime-style call with a
   personal agent.
2. The agent asks: **day summary** or **add a new task**.
3. On hang up, the conversation transcript is sent to Ambiguous.ai, which
   schedules and plans on the user's behalf.

Every agent has a **distinct persona** — name, role, personality, theme
color, and greeting. The call UI shows two surfaces: the agent's full-screen
visual (animated orb now, real generated video later) and the user's camera
in a draggable picture-in-picture tile.

## 2. Repository layout

```
/
├── README.md
├── AGENTS.md                 ← this file
├── LICENSE
└── frontend/                 ← React + Vite app (self-contained deployable)
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.jsx          ← entry point
        ├── App.jsx           ← agent list loading + selection; renders CallScreen
        ├── agents.js         ← LOCAL FALLBACK personas (used when no API key)
        ├── styles.css        ← all styling, CSS custom properties
        ├── api/
        │   └── ambiguous.js  ← THE Ambiguous.ai boundary (only place w/ fetch)
        └── components/
            ├── CallScreen.jsx    ← call UI + conversation state machine
            └── AgentSurface.jsx  ← full-screen agent visual (orb today)
```

**Do not move `frontend/`'s concerns into the root.** The frontend is a
separate deployable so it can be built and iterated on independently.

## 3. Commands

| Task              | Command                                |
| ----------------- | -------------------------------------- |
| Install deps      | `cd frontend && npm install`           |
| Dev server        | `cd frontend && npm run dev`           |
| Production build  | `cd frontend && npm run build`         |
| Preview build     | `cd frontend && npm run preview`       |

Verify any frontend change with `npm run build` before considering it done.

## 4. Sub-agent roles

When parallelizing work, split along these boundaries. Each role owns its
files exclusively — **never let two agents edit the same file.**

### 4.1 Frontend UI Agent
- **Owns:** `frontend/src/components/`, `frontend/src/styles.css`
- Builds and polishes the call interface: agent surface, camera PiP,
  captions, controls, persona theming, animations, responsive layout.
- Must not touch `agents.js` schema or `App.jsx` state flow without
  coordinating with the Orchestration role.

### 4.2 Persona / Conversation Agent
- **Owns:** `frontend/src/agents.js`, greeting/script logic, the
  summary/new-task branching dialogue inside `CallScreen`
- Designs personas (name, role, tagline, theme, greeting, speaking style)
  and the day-summary / new-task conversation.
- Personas must feel human: distinct voice, consistent tone, no generic
  chatbot phrasing.

### 4.3 Integration Agent
- **Owns:** `frontend/src/api/ambiguous.js`, backend files at repo root
- Owns the contract with Ambiguous.ai: `fetchCoworkers` (agent roster),
  `fetchDaySummary` (calendar + tasks), `createTask`, `askAssistant`
  (live mid-call requests — scheduling, planning), and `sendConversation`
  (transcript handoff on call end for validation).
- Components must NEVER fetch Ambiguous endpoints directly — they call
  these five functions. Every function must degrade gracefully when
  `VITE_AMBIGUOUS_API_KEY` is unset so the app works offline.

### 4.4 Media Agent (future)
- **Owns:** agent visual surface, audio I/O
- Swaps the animated orb for real generated video / visual interpolation,
  and wires microphone → STT and TTS → speaker.
- The `AgentSurface` component boundary is the seam for this work; keep its
  props stable (`agent`, `speaking`).

## 5. Architecture rules

1. **Small state, one owner.** `App.jsx` holds only the selected agent.
   `CallScreen.jsx` owns the call phase machine:
   `connecting → live → sending → done` (plus `awaitingTask` for the
   new-task branch). Components below that are presentational.
2. **Personas are data, not code.** Adding an agent = adding an entry to
   `agents.js`. Never hardcode a persona inside a component. Agent
   switching happens in-call via the switcher; re-greeting on switch is
   driven by the `[agent]` effect in `CallScreen`.
3. **The Ambiguous.ai boundary is explicit.** Anything that would call the
   Ambiguous API goes through `src/api/ambiguous.js`. When no API key is
   configured the UI must keep working end-to-end on local fallbacks.
4. **Media is behind a seam.** `AgentSurface` renders whatever visual the
   persona defines. Today's orb and tomorrow's video stream share the same
   props.
5. **Graceful degradation.** If `getUserMedia` fails or is denied, the app
   keeps working — show a "No camera" placeholder tile and let the user
   continue by text.

## 6. Code style

- **JavaScript (JSX), functional components, hooks only.** No classes.
- Keep components under ~150 lines; extract helpers rather than nesting.
  (`CallScreen` is currently at the limit — new features should extract,
  not grow it.)
- CSS: custom properties for theme values; persona color comes from
  `agent.theme` via the `--agent-color` inline var, never a per-agent
  stylesheet.
- No TypeScript for the hackathon — keep velocity. Add JSDoc on the
  `agents.js` schema and the Ambiguous payload shape instead.
- No new dependencies without a reason; prefer platform APIs
  (`getUserMedia`, `SpeechSynthesis`, `fetch`) over libraries.
- No comments unless the code is genuinely non-obvious. No TODO comments —
  track work in the README roadmap.

## 7. Security & privacy

- **Never commit secrets.** API keys for Ambiguous.ai go in
  `frontend/.env.local` (gitignored) as `VITE_AMBIGUOUS_API_KEY`, or in a
  backend env — never in source.
- Camera/mic streams stay local unless a feature explicitly sends them.
  Do not record or upload media silently.
- Don't log transcripts or user data to the console in committed code.
- **Never commit `node_modules/` or `dist/`.** They are gitignored — keep
  them that way.

## 7.1 Ambiguous.ai platform knowledge

What Ambiguous is (from ambiguous.ai docs):

- A workspace for human–AI collaboration: **17 apps** (Docs, Sheets,
  Slides, Wiki, Mail, Chat, Forms, Sign, Tasks, Calendar, CRM, Drive,
  Identity, Assistant, Admin, Automations). Every feature has both a human
  UI and an agent endpoint — "everything you can do, your agent can do."
- Agents are **AI coworkers**: each gets its own account, email on the
  workspace domain, calendar, tasks, and API key. You reach them via email,
  chat message, task assignment, or @mention — our app adds "call" to that.
- Base URL: `https://app.ambiguous.ai/api`. Auth:
  `Authorization: Bearer ak_...` (keys at app.ambiguous.ai/admin).
  MCP server also exists for tool-style access.

Endpoints we use (all under `/api`):

| Purpose                    | Endpoint                                   |
| -------------------------- | ------------------------------------------ |
| List coworkers (agents)    | `GET /users`                               |
| Today's schedule           | `GET /calendar/events?from=&to=`           |
| Open tasks                 | `GET /tasks`                               |
| Add a task from a call     | `POST /tasks`                              |
| Live mid-call requests     | `POST /assistant/chat`                     |
| Transcript handoff         | `POST /assistant/chat`                     |
| (Future) message a coworker| `POST /channels/:id/messages`              |
| (Future) provision agent   | `POST /admin/users/provision-agent`        |

Response shapes are inferred from public docs — verify against a real key
and adjust `coworkerToPersona()` / payload bodies to match the true
schema. `sendConversation` must never throw.

## 8. Definition of done

A change is done when ALL of the following hold:

- `npm run build` in `frontend/` passes with no errors.
- The `connecting → live → sending → done` flow still works end-to-end,
  including re-dial and mid-call agent switching.
- Agent personas still render distinctly (theme, name, greeting).
- The Ambiguous.ai boundary is still behind its single stub/module.
- No secrets, no `console.log` of user data, no dead code left behind.

## 9. Known seams for future work

| Future feature            | Where it plugs in                          |
| ------------------------- | ------------------------------------------ |
| Real agent video/avatars  | `AgentSurface` component                   |
| Speech-to-text input      | composer input / `handleSend` in CallScreen |
| Text-to-speech output     | `agentSay()` / `speaking` state in CallScreen |
| Ambiguous.ai live API     | `src/api/ambiguous.js` (set the API key)   |
| Auth / per-user agents    | `App.jsx`, above the CallScreen            |
