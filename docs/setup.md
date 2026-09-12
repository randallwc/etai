Setup notes
===========

Workspace
---------

Provisioned 2026-09-12 via:

  npx ambiguous auth signup --name etai --human-email albinshr@amazon.com \
    --workspace-name etai

Result: workspace etai-workspace (etai-workspace.ambi.cc), agent "etai"
with its own email etai@etai-workspace.ambi.cc. API key lives in
./.ambi/config.json (gitignored) and was copied into
frontend/.env.local as VITE_AMBIGUOUS_API_KEY.

Pending step for a human: the verification link sent to
albinshr@amazon.com claims ownership and unlocks invites, billing, and
provisioning additional agents.

CLI
---

npx ambiguous@latest is a dynamic shell over the workspace OpenAPI spec.
Useful commands: "catalog" lists everything, "catalog <module>" lists one
module, "api GET|POST <path> [-d json]" is the raw escape hatch,
"coworkers list" shows agent users, "skill" prints the operating guide.
Auth resolves from AMBI_API_TOKEN, then ./.ambi/config.json (searched
upward), then ~/.ambi/config.json.

Tests and hooks
---------------

Backend tests run with "npm test" at the root (node --test over
'*/tests/*.test.js'). A pre-commit hook at .githooks/pre-commit runs
them on every commit; core.hooksPath=.githooks is set repo-wide.

Frontend tests run with "npm --prefix frontend test" (vitest + v8
coverage, 80 percent line and branch thresholds on src/api and src/lib).
scripts/pre-commit.sh runs them, but it is not wired into any active
hook -- core.hooksPath=.githooks means .git/hooks is bypassed, so
frontend tests currently do not run on commit. Run them manually before
committing frontend work, or fold that script into .githooks/pre-commit.
