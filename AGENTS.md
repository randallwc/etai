# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.
Read this file fully before making changes. When it conflicts with a
guess, this file wins.

## 1. Engineering rules

1. No comments in code. Docstrings only on external, well-named
   functions. Every file opens with a docstring: one sentence on what
   it is and one on why it is the minimum.
1. Never use em dashes. Use single hyphens when punctuation needs a dash.
   Keep sentences plain English, short, and to the point.
1. Delete stale code and docs when replacing a flow.
1. Keep one source of truth per feature. Update or remove conflicting docs
   in the same change.
1. Keep README focused on what runs now. Cut features and their upgrade
   path go in docs/notes.md.
1. For changes, report only changed files, verification run, and known
   limitation.
1. Avoid filler terms such as "robust," "seamless," "comprehensive,"
   "leverages," and "future-proof."
1. Every new file needs a named owner and a reason it cannot fit an
   existing file.
1. Prefer concrete acceptance criteria over vague product language.
1. Always pull with rebase before pushing. Use autostash when the worktree
   has other agents' changes, then resolve any restore conflicts without
   changing their work.
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
1. Tests: smoke-level only. Root `npm test` proves the service path;
   frontend tests cover the api boundary. Do not rebuild unit suites.

## 2. Project mission

A personal MVP: a **call-your-agent** web app plus a text-in text-out
scheduling service on top of Ambiguous.ai. The user opens the app and
is immediately in a FaceTime-style call with the etAI agent.
Scheduling requests book real calendar events after checking
free/busy availability; other requests become tasks. On hang up, the
transcript is stored in the workspace as a document.

One agent, one persona, one scheduling brain.

## 3. Repository layout

```
/
├── README.md
├── AGENTS.md                  this file
├── LICENSE
├── package.json               scripts: test, start, dev, build
├── .githooks/pre-commit       runs root npm test (core.hooksPath=.githooks)
├── docs/                      prose documentation, unix format, no tables
├── messaging/                 THE service - texts and voice turns in,
│   │                          replies out. One process, no deps.
│   │                          Docs: docs/messaging.md
│   ├── index.js               HTTP surface, env, per-thread queues,
│   │                          reminder timer, wiring (createService)
│   ├── transports.js          the wire: ambimail + sim transports,
│   │                          inbound normalization, mail poller
│   ├── loop.js                intent -> calendar tools -> reply
│   ├── ai.js                  assistant/chat classification + prompts,
│   │                          keyword fallback
│   ├── calendar.js            calendar adapter + stub fallback
│   ├── state.js               threads/jobs/customers/dedup/action log
│   ├── ambiguous.js           THE backend Ambiguous boundary
│   └── tests/smoke.test.js    high-level smoke tests only
└── frontend/                  React + Vite app (self-contained deployable)
    ├── index.html
    ├── package.json
    ├── vite.config.js
    ├── vitest.config.js       coverage thresholds: 80% on src/api
    ├── .env.local             VITE_AMBIGUOUS_API_KEY, VITE_BUS_URL
    │                          (gitignored)
    └── src/
        ├── main.jsx           entry point
        ├── App.jsx            shell + the single AGENT persona
        ├── styles.css         all styling, CSS custom properties
        ├── api/ambiguous.js   THE Ambiguous boundary - transcript docs
        └── components/
            ├── CallScreen.jsx     call UI, conversation machine,
            │                      voiceTurn + speak helpers
            └── AgentSurface.jsx   full-screen agent visual (Rive pin)
```

## 4. Commands

No Makefiles - plain npm scripts.

Service: `npm start` (node messaging/index.js, PORT default 4020)
Root tests: `npm test` (node --test over '*/tests/*.test.js'; the glob
form is required, `node --test <dir>` does not discover tests)
Install deps: `cd frontend && npm install`
Dev server: `npm run dev`
Build: `npm run build`
Frontend tests: `npm --prefix frontend test`
Ambiguous CLI: `npx ambiguous@latest catalog` (from repo root - uses
./.ambi/config.json)

Verify any backend change with root `npm test`; verify any frontend
change with `npm run build` and `npm --prefix frontend test` before
considering it done. Note: the commit hook runs only root `npm test` -
run the frontend suite yourself before committing frontend changes.

## 5. Boundaries

One scheduling brain exists: `messaging/loop.js`. Inbound texts and
voice turns reach it through `messaging/index.js`, which enqueues per
threadKey. Never add a second scheduler - the frontend calls
`POST /voice/turn` and shows a clear error when the service is down.

The Ambiguous boundary is one file per side: `messaging/ambiguous.js`
(backend) and `frontend/src/api/ambiguous.js` (browser). Components
never fetch Ambiguous endpoints directly. Read docs/ambiguous.md
before touching either file.

Per-thread state lives in `messaging/state.js`; the store is the only
mutable model. `CallScreen.jsx` owns the call phase machine:
connecting, live, sending, done. The persona is data in `App.jsx`,
never hardcoded in a component. `AgentSurface` renders whatever visual
the persona defines; keep its props (`agent`, `speaking`) stable.

Loud failure over silent fallback: when the service is unreachable the
UI says so; it never schedules locally.

## 6. Definition of done

Root `npm test` passes (runs on every commit via .githooks). For
frontend work: `npm run build` and `npm test` pass, and the connecting,
live, sending, done flow still works end-to-end including re-dial.
The Ambiguous boundary stays in `src/api/ambiguous.js` (frontend) and
`messaging/ambiguous.js` (backend). No secrets, no dead code.
