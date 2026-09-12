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

Frontend tests run with "npm --prefix frontend test" (vitest + v8
coverage, 80 percent line and branch thresholds on src/api and src/lib).
A pre-commit hook at scripts/pre-commit.sh runs them on every commit;
it is installed into .git/hooks/pre-commit. Re-install after a fresh
clone with:

  cp scripts/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
