FAISAL MEMORY -- Devin's own notes for this machine and repo
============================================================

Context survives in this file. Update it when something non-obvious is
learned. SHARED_MEMORY.md is the team-facing version; keep it in sync on
anything other agents need.

ENVIRONMENT
-----------

  - This box is faisal's. Repo: /home/ubuntu/hackathon_2026, remote
    origin = git@github.com:randallwc/etai.git (SSH). Pushes auth as
    faisalaljishi; collaborator access was granted mid-session.
  - Git identity set repo-local: faisal aljishi <faisalaljishi@outlook.com>.
    All my commits are authored as faisal per explicit request; the
    "Generated with Devin" trailer stays in the body.
  - Node arrived via `apt install nodejs npm` (v22.22.1, npm 9.2.0) after a
    slow tarball download was abandoned. There is no bun/deno/python-toml
    stack; plain node only.
  - core.hooksPath is .githooks -- every commit runs `npm test`. Commits
    fail if tests are red.

INCIDENT LOG (do not repeat these)
----------------------------------

  - I rewrote two of my own commits' authorship with git filter-branch
    AFTER they were already pushed to the old remote. That orphaned the
    shared ancestry with randallwc/etai and cost a soft-reset recovery.
    Rule now: never rewrite history that anyone else might have fetched.
  - `git pull` needed --allow-unrelated-histories exactly once (the etai
    repo had its own init history). After the reset --soft + recommit,
    histories share ancestry again -- plain pulls work now.
  - Teammates push constantly. Always `git pull --no-rebase` immediately
    before `git push`; expect rejections otherwise.
  - `pkill -f 'node messaging/index.js'` matched my own shell command line
    and killed the shell. Kill by port instead: `fuser -k 4020/tcp`.
  - `node --test <dir>` does not discover tests in a dir arg on this
    version; the glob '*/tests/*.test.js' in package.json is load-bearing.
  - A `.secrets.swp` file appeared in the worktree (someone editing a
    secrets file in vim). .secrets* and *.swp are gitignored now. Never
    commit them; never print their contents.
  - core.hooksPath=.githooks means .git/hooks is ignored entirely --
    scripts/pre-commit.sh (frontend vitest) does NOT run on commit, only
    root `npm test` does. setup.md's install note is stale; corrected.
  - Files change under me mid-session: a teammate landed an ambimail
    transport commit and uncommitted shared/env.js + messaging/index.js
    edits while I worked. Re-read files before editing, stage only my
    own paths, never `git add -A`.

WHAT I OWN / TOUCHED
--------------------

  - messaging/ (index.js, normalize.js, transports.js, tests/) -- built,
    green, sim transport works, BlueBubbles path coded but untested
    (no Mac on this box).
  - docs/{GOAL,API,INTERFACES,CALENDAR,PHONE,messaging}.md -- contracts I
    wrote pre-implementation; CALENDAR.md's REST contract is now an
    alternative, the live calendar path composes verified primitives.
  - models/{phone,calendar}-contract.schema.json + models/tests/
    schemas.test.js -- the wire contracts as JSON Schema + a ~60-line
    subset validator (no ajv, zero-dep rule).
  - models/{contractor,customer,job,agent-action,message}.schema.json --
    the agent-core data model, schema-first before agent/ code lands.
  - docs/messaging-plan.md -- the messaging-side work plan (agent core
    build order, transport ladder, decisions).
  - AGENTS.md refresh: real repo layout, backend commands, messaging +
    agent-core sub-agent roles, hook caveat in definition of done.
  - package.json test script (glob fix) and .gitignore hardening.

TEAM MAP (inferred)
-------------------

  - frontend/ + docs/ambiguous-integration.md: integration agent verified
    the real Ambiguous API live against etai-workspace.ambi.cc.
  - calendar-agent/: another agent; its assistant-chat script is stale
    (assistant/chat is not in the live OpenAPI catalog).
  - personas.js, CallScreen etc.: frontend/persona agents.
  - If unsure who owns a file, check git log -1 --format='%an' <file>.

DECISIONS LOCKED WITH THE USER
------------------------------

  - Channel: iMessage-first (user chose the bridge despite Mac risk);
    sim transport is the unblocker.
  - Ambiguous is required, not optional.
  - Stack was "TypeScript + Node" early, superseded by repo convention:
    plain JS, zero deps (AGENTS.md wins).
  - No UI for the agent service; frontend/ is the team's UI.
  - Tests: user overrode the 80% blanket rule -- "ONLY for important
    portions." Important = contract-critical paths (normalize, dedup,
    self-echo filter, send validation, schema drift). Do not re-add
    trivial tests.

NEXT
----

  - Agent core: consume messaging inbound, intent -> Ambiguous tools ->
    reply via /send. Full plan and build order: docs/messaging-plan.md.
    Data-model schemas for it are committed under models/ (contractor,
    customer, job, agent-action, message).
  - If a Mac appears: BlueBubbles checklist in docs/messaging.md.
  - Vapi for voice stretch: POST /webhooks/voice-toolcall spec in PHONE.md.
