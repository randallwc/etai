DEEP DIVE PROMPTS -- remaining work across the whole system
===========================================================

Read AGENTS.md fully before running any prompt below. Every prompt
inherits its rules: schema first under models/ (commit the schema before
code), no code comments, no em dashes, KISS/ponytail, one owner per file,
verify backend with root `npm test` and frontend with `npm run build` +
`npm test`, pull --rebase before push.

VERIFIED LIVE 2026-09-12 (do not redo, build on it)
-------------------------------------------------

Against the real workspace etai-workspace.ambi.cc:

- Calendar round trip: POST/PATCH/DELETE /calendars/:id/events all work;
  GET /calendars/events and /calendars/availability return the documented
  shapes. PATCH accepts past times; POST rejects them (400,
  "Cannot create an event in the past without force=true") - bus
  proposeSlots now clamps same-day slots to now + 15 min so creates
  never land in the past.
- POST /tasks returns {task:{id, task_key:"TASK-NNN", ...}}.
- POST /documents stores the call transcript; content is wrapped into a
  doc node tree by the server.
- POST /voice/turn on the bus drives a real assistant/chat classify and
  replies in ~10-30 s. The bus Ambiguous client uses a 60 s timeout -
  do not lower it.
- /simulate/inbound on messaging fans out to bus /webhooks/inbound; the
  loop ran and created the thread.
- /send over the ambimail transport is accepted by Ambiguous mail and
  targets <digits>@vtext.com. CARRIER_GATEWAY is per-deployment, not
  per-recipient (see prompt 4).
- The workspace has exactly one user (the etai agent, type "agent").
  bus/calendar.js ids() picks type==="human" first then users[0], so
  all availability reads run against the agent's calendar.

ORDER
-----

  1. voice turn parity       -- frontend, no schema needed
  2. bus read API for board  -- schema first, then bus + frontend
  3. real inbound text path  -- messaging, verify + document
  4. per-recipient carrier   -- messaging, schema-free config
  5. contact name learning   -- bus, extends existing intent fields
  6. calendar webhook source -- bus, verify or delete dead endpoint
  7. error surfacing         -- bus, reply text only
  8. scripted phone e2e      -- scripts/, reuses running stack
  9. dependency audit        -- package-lock only
 10. demo day runbook        -- docs only

PROMPT 1 -- route call turns through the bus
--------------------------------------------

Owns: frontend/src/api/bus.js (new), frontend/src/components/CallScreen.jsx,
frontend/src/api/bus.test.js, frontend/.env.local (VITE_BUS_URL), docs/.

```
You are working in the etai repo (read AGENTS.md, docs/bus.md,
docs/dispatch-prompts.md). Today a voice call and a text to the same
agent use two different brains: SMS goes through the bus loop (real
booking, CRM sync, contractor notifications) while CallScreen uses
frontend/src/lib/parseRequest.js + api/ambiguous.js scheduleMeeting,
which books events the bus never sees - no contractor text, no job
record, no thread.

Tasks:
1. Add frontend/src/api/bus.js - the ONLY frontend file that talks to
   the bus. voiceTurn({ from, body }) -> POST {VITE_BUS_URL}/voice/turn,
   resolves reply string, resolves null when VITE_BUS_URL is unset or
   the request fails. Same boundary pattern as api/ambiguous.js and
   api/notify.js; never throw at the UI.
2. In CallScreen, when VITE_BUS_URL is set send each user turn to
   voiceTurn first; use the returned reply as the agent line. Keep the
   existing api/ambiguous.js handleRequest path as the fallback when the
   bus is unreachable - the call must still work with only
   VITE_AMBIGUOUS_API_KEY set.
3. Use a stable per-call `from` (a fixed demo E.164 or VITE_DEMO_PHONE)
   so the bus thread survives the whole call.
4. bus.test.js: request shape, reply extraction, both fallback branches.
   Keep the 80 percent coverage gate.

Verify: cd frontend && npm run build && npm test; then with bus on
:4010, speak "what's my day" in a call and confirm the reply matches
what an SMS of the same text returns.
```

PROMPT 2 -- board reads real bus state
---------------------------------------

Owns: models/board-state.schema.json (new, commit first), bus/index.js
(read endpoint only), bus/tests/, frontend/src/api/bus.js (extend from
prompt 1), frontend/src/App.jsx, frontend/src/components/Board.jsx.

```
You are working in the etai repo (read AGENTS.md; schema-first rule).
The dispatch board renders seed.json from localStorage, so bookings made
by real texts never appear on the console.

Tasks:
1. models/board-state.schema.json: the read shape the console needs -
   { jobs: Job[], customers: Customer[], actions: AgentAction[] } reusing
   the field names already in models/. Commit this file first.
2. bus/index.js: GET /state returns that shape from the store (read
   only, no auth beyond localhost for now - note the limitation in
   docs/bus.md). Tests for the endpoint.
3. frontend api/bus.js: fetchBoard() -> GET {VITE_BUS_URL}/state,
   null when unset or failed.
4. App.jsx: on load and on a 15 s interval while the console is open,
   merge fetchBoard() over the local board when present; keep
   localStorage persistence as the offline path. Do not remove seed -
   the demo must work with no backend.

Verify: root npm test; cd frontend && npm run build && npm test; book a
job over the sim chat (scripts/chat.js) and watch it appear on the
board.
```

PROMPT 3 -- prove the real inbound text path
---------------------------------------------

Owns: docs/messaging.md, messaging/ (only if a bug surfaces).

```
You are working in the etai repo (read AGENTS.md, docs/messaging.md,
docs/PHONE.md). Outbound SMS is verified: /send -> ambimail ->
<digits>@vtext.com. Inbound relies on the carrier's reply address
delivering to the Ambiguous workspace inbox, which mailpoller reads
every MAIL_POLL_SECONDS and fans out.

Tasks:
1. Send a real /send to the demo phone, reply to it from the handset,
   and confirm the reply lands in GET /api/mail/inbox, that
   mailpoller picks it up (fromMail must parse the vzwpix.com reply
   address back to the phone), and that the bus answers with a real
   SMS back to the phone.
2. Document the observed latency of each hop and the exact reply
   address shape in docs/messaging.md so the next agent does not
   rediscover it.
3. If Ambiguous exposes an outbound mail webhook (check
   docs/ambiguous-integration.md and the API), wire /webhooks/ambimail
   as the fast path and keep polling as fallback. If not, say so in
   docs and move on.

Verify: one full text round trip on real handsets, timings written into
docs/messaging.md.
```

PROMPT 4 -- per-recipient carrier gateway
------------------------------------------

Owns: messaging/transports.js, messaging/index.js, docs/messaging.md,
messaging/tests/.

```
You are working in the etai repo (read AGENTS.md, docs/messaging.md).
ambimail maps every recipient to one CARRIER_GATEWAY, which silently
drops texts to numbers on other carriers - the demo already hit this
once (AT&T gateway, Verizon phone, nothing delivered).

Tasks:
1. Replace the single CARRIER_GATEWAY with CARRIER_GATEWAYS, a JSON map
   of E.164 -> gateway domain, falling back to CARRIER_GATEWAY for
   unlisted numbers. Both stay optional; sim remains the default
   transport.
2. Seed .env.example with the two known entries
   (+15550100100 -> vtext.com, +15550100101 -> txt.att.net) and
   document the failure mode in docs/messaging.md: wrong gateway =
   silent drop, no error anywhere.
3. Tests: map lookup, fallback, malformed JSON map -> fallback, not a
   crash.

Verify: root npm test; /send to one number on each carrier from the
map.
```

PROMPT 5 -- learn customer names from texts
--------------------------------------------

Owns: bus/ai.js, bus/loop.js, bus/tests/.

```
You are working in the etai repo (read AGENTS.md, docs/bus.md).
models/intent.schema.json already has a `name` field and loop.js already
calls upsertCustomer + crmSync, but the fallback classifier and the
prompt barely use name - "hi it's Sam, need a locksmith" stores the
phone as the display name forever.

Tasks:
1. Extend the classify prompt with an explicit name-extraction rule and
   extend fallbackClassify with the common patterns ("it's <name>",
   "this is <name>", "<name> here") so name works even with no API key.
2. In loop.js, store the name on upsertCustomer for any intent that
   carries one, not just book. Use it in the booking event title and the
   contractor notification instead of the raw phone when present.
3. Tests for both the classifier paths and the notify text.

Verify: root npm test; a text "hey it's Sam, my sink is leaking" ->
contractor notice says Sam, not a phone number.
```

PROMPT 6 -- calendar webhook: wire it or cut it
------------------------------------------------

Owns: bus/index.js (/webhooks/calendar), docs/bus.md,
models/calendar-notification.schema.json.

```
You are working in the etai repo (read AGENTS.md; deletion over
addition). The bus exposes POST /webhooks/calendar which texts the
contractor on calendar notifications, but nothing is verified to push
to it - calendar-agent/notify.js may have been the intended producer.

Tasks:
1. Check whether Ambiguous can push calendar-change notifications
   (docs, /api surface, or the team). If yes: register the bus webhook
   and document the subscription. If no: either make calendar-agent
   poll and POST the contract, or delete the endpoint, the schema, and
   its docs in one change. A dead endpoint is worse than none.
2. Keep notifyContractor dedup on cal:<id> either way.

Verify: root npm test; a real calendar change produces a contractor
text, or the endpoint is gone and docs agree.
```

PROMPT 7 -- failure replies that say what broke
------------------------------------------------

Owns: bus/loop.js, bus/tests/.

```
You are working in the etai repo (read AGENTS.md). Every tool failure
in the loop becomes "Sorry - I couldn't reach the calendar just now",
including ones that will never self-heal (auth, not_found).

Tasks:
1. bus/ambiguous.js already tags errors with code not_found|auth|
   upstream. In the loop's catch, map auth -> "my calendar connection
   needs a new key - tell the contractor", not_found -> "that booking
   isn't on the calendar anymore" and clear the job's
   ambiguousEventId, upstream -> keep the current text.
2. Contractor-originated failures can say more than client-facing ones -
   never expose internals to a customer phone.
3. Tests for each code path.

Verify: root npm test; kill the API key and confirm a contractor text
gets the rekey message.
```

PROMPT 8 -- scripted real-phone e2e
------------------------------------

Owns: scripts/e2e-phone.js (new), docs/messaging.md (how to run).

```
You are working in the etai repo (read AGENTS.md; look at
scripts/demo.js and scripts/chat.js first - reuse their harness, do
not write a third one).

Write a repeatable e2e against the RUNNING stack (messaging :4020, bus
:4010, real ambimail transport): POST /simulate/inbound from
CLIENT_PHONE, then poll the messaging service and the Ambiguous mail
outbox/inbox until the agent's reply is observed end to end, and assert
the "etAI update: " prefix on the outbound body. Parameterize numbers
and URLs via env; time out each step; print a pass/fail per step like
demo.js. Document the run command in docs/messaging.md.

Verify: node scripts/e2e-phone.js passes against the live services.
```

PROMPT 9 -- dependency audit
-----------------------------

Owns: frontend/package-lock.json, package-lock.json.

```
You are working in the etai repo. As of 2026-09-12 the root tree is
clean and frontend/ has 6 remaining advisories, ALL in the vite /
vitest / esbuild dev chain (esbuild dev-server request forgery,
vitest mocker path traversal). `npm audit fix` resolves none of them;
every fix requires --force to vite@8 / vitest@4, a breaking upgrade.

Do the upgrade deliberately, not as a drive-by: bump vite and vitest
together, pin versions at least a week old, rerun `npm run build` and
`npm test`, and confirm the vitest coverage thresholds still parse
(vitest 4 changed coverage config keys - check vitest.config.js still
applies). If the dev server or tests regress, revert the bump and
record the blocker here instead of shipping it.
```

PROMPT 10 -- demo day runbook
------------------------------

Owns: docs/demo-day.md (new).

```
You are working in the etai repo (read AGENTS.md, docs/messaging.md,
docs/setup.md, SHARED_MEMORY.md). Write the runbook the team follows on
demo day, prose not tables:

- exact env vars for .env and frontend/.env.local and which phone each
  number is (contractor handset vs client handset)
- start order: messaging, bus, frontend; the healthz fields that prove
  each link (transport=ambimail, ambiguous=true, stub=false,
  subscribers>=1)
- the three demo paths: real SMS both directions, sim chat
  (scripts/chat.js) as the no-signal fallback, the web console call
- reset steps between takes: bus/.state.json, localStorage key
  etai.board.v3, clearing the seeded Ambiguous calendar
- known latency numbers (assistant classify 10-30 s, mail poll 15 s)
  and the silent-drop carrier gotcha
```

NOTES
-----

- The single biggest product gap is prompt 1 + 2: today the call path
  and the SMS path are different brains with different state. Unify on
  the bus loop and the console becomes a live view of real bookings.
- frontend/.env.local is gitignored; never commit keys. Repo .env is
  gitignored too.
- Do not add a fourth transport or a second Ambiguous client; extend
  transports.js and bus/ambiguous.js in place.
