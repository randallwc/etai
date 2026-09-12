DISPATCH PROMPTS -- split work across agents
============================================

Product direction for the frontend: this is now a management console for
trade jobs that require physical presence (locksmith, plumber,
electrician). The contractor sees one screen: a unified list of agents
and customers, a detail pane per job, a map, and two primary actions --
"on my way" (texts the customer an ETA over the messaging service) and
"mark resolved". Camera stays off until we need it.

Read AGENTS.md first -- every prompt below inherits its rules: schema
first under models/, no code comments, KISS/ponytail, 80 percent
coverage on new lib code, verify with frontend `npm run build` and
`npm test`, root `npm test` for anything under messaging/ or models/.

SHARED CONTRACTS
----------------

These signatures are the seams between agents. Implement exactly these
names so parallel work composes; a consumer may stub them while the
owner builds.

  // frontend/src/lib/jobs.js -- pure, tested, localStorage persistence
  loadBoard()                       -> { contractor, customers, jobs }
  saveBoard(board)                  -> void
  transition(board, jobId, action)  -> board  // 'depart' | 'resolve' | 'cancel'
  seedBoard()                       -> board  // demo locksmith data

  // frontend/src/api/lookup.js -- extend, keep geocode/driveMinutes/precipAt
  route(from, to)                   -> { meters, minutes } | null
                                     // {lat, lon} in, OSRM driving route out

  // frontend/src/lib/eta.js -- pure, tested
  formatMiles(meters)               -> "3.2 mi"
  etaLabel(minutes)                 -> "~25 min"
  etaClock(minutes)                 -> "10:42 AM"  // now + minutes

  // frontend/src/lib/location.js
  currentPosition()                 -> Promise<{lat, lon} | null>
                                     // navigator.geolocation, null on deny

  // frontend/src/api/notify.js -- messaging boundary, mirrors ambiguous.js
  sendSms({ to, body, threadKey })  -> Promise<{ sent: bool, via: string }>
  etaMessage({ contractor, customer, job, milesText, etaText }) -> string

Job.status already supports the flow: confirmed -> en_route -> done
(plus requested/canceled). customer.phone is E.164 and is the threadKey
per docs/PHONE.md. Do not invent new status names.

ORDER
-----

  1. schema + board store   -- commit first (rule: schema before code)
  2. ETA/distance lib       -- parallel with 1
  3. SMS notify client      -- parallel with 1 and 2
  4. dispatcher UI          -- after 1, or parallel against the contracts
  5. map view               -- parallel with 4 (slot component)
  6. inbound replies        -- optional, backend, independent

PROMPT 1 -- schemas and board store
-----------------------------------

Owns: models/dispatch-board.schema.json, frontend/src/lib/jobs.js,
frontend/src/lib/jobs.test.js, frontend/src/data/seed.json (demo data).

```
You are working in the etai repo (read AGENTS.md fully first; obey the
schema-first rule -- commit the schema before the code).

The frontend is becoming a dispatcher console for trade contractors
(locksmith/plumber/electrician): a board of customers and jobs with
statuses confirmed -> en_route -> done.

Tasks:
1. Add models/dispatch-board.schema.json: { contractor (reuse the
   Contractor shape), customers: Customer[], jobs: Job[] }. Reuse the
   field names from models/customer.schema.json and
   models/job.schema.json; inline the properties (JSON Schema files here
   do not use $ref). Commit this file first.
2. Write frontend/src/lib/jobs.js implementing the contract in
   docs/dispatch-prompts.md: loadBoard/saveBoard over localStorage key
   "etai.board", transition(board, jobId, action) mapping
   depart->en_route, resolve->done, cancel->canceled, and seedBoard()
   returning a locksmith demo board loaded from src/data/seed.json
   (3-4 customers/jobs with real-looking Seattle addresses and E.164
   phones like +1555...). Pure functions, no React.
3. Tests in jobs.test.js covering load/save round-trip, every
   transition, and invalid action rejection. Meet the 80 percent
   coverage gate.

Verify: cd frontend && npm test && npm run build, then root npm test.
```

PROMPT 2 -- ETA and distance library
------------------------------------

Owns: frontend/src/api/lookup.js (extend only), frontend/src/lib/eta.js,
frontend/src/lib/eta.test.js, frontend/src/lib/location.js.

```
You are working in the etai repo (read AGENTS.md first; KISS, no
comments, 80 percent coverage on lib code).

The dispatcher UI needs distance and ETA between the contractor's
current position and a job's address. Distance is the primary number
(the customer cares "how far", time is approximate). All lookups are
free and keyless: Nominatim (geocode) and OSRM (route) already live in
frontend/src/api/lookup.js -- extend that file, do not create a second
fetch module.

Tasks:
1. Add route(from, to) to lookup.js: OSRM /route/v1/driving returning
   { meters, minutes } from route.distance/duration, null on failure.
   Keep the existing overview=false pattern and AbortSignal timeout.
2. Write lib/eta.js: formatMiles (meters -> one decimal "X.X mi"),
   etaLabel ("~N min", under 2 min -> "arriving"), etaClock (now +
   minutes -> "h:mm AM/PM"). Pure, unit-testable.
3. Write lib/location.js: currentPosition() wrapping
   navigator.geolocation.getCurrentPosition, resolving null on
   denial/unavailability after ~5s.
4. Extend the existing lookup tests and add eta.test.js to keep
   coverage at 80 percent.

Verify: cd frontend && npm test && npm run build.
```

PROMPT 3 -- SMS notify client
-----------------------------

Owns: frontend/src/api/notify.js, frontend/src/api/notify.test.js.

```
You are working in the etai repo (read AGENTS.md and docs/PHONE.md --
the outbound contract is POST {PHONE_SERVICE_URL}/send with
{ to, body, threadKey }).

The dispatcher console texts the customer when the contractor hits "on
my way". Create frontend/src/api/notify.js -- the ONLY frontend file
that talks to the messaging service, the same boundary pattern as
api/ambiguous.js. Base URL from import.meta.env.VITE_MESSAGING_URL.

Tasks:
1. sendSms({ to, body, threadKey }): POST {VITE_MESSAGING_URL}/send,
   JSON body per PHONE.md. Resolve { sent: true, via: "messaging" } on
   200. When VITE_MESSAGING_URL is unset or the request fails, resolve
   { sent: false, via: "none" } -- never throw at the UI.
2. smsHref({ to, body }): a `sms:${to}?&body=${encodeURIComponent(body)}`
   fallback URL so the demo can still send via the native Messages app
   when no messaging service is up.
3. etaMessage({ contractor, customer, job, milesText, etaText }):
   short plain text signed as the contractor's business, e.g.
   "Hi Sam, Al's Lock & Key here -- on my way, about 4.2 mi out,
   ETA ~10:42 AM." One template, no emoji.
4. notify.test.js: template output, request shape (mock fetch), and
   both fallback branches. Coverage 80 percent.

Verify: cd frontend && npm test && npm run build.
```

PROMPT 4 -- dispatcher UI
-------------------------

Owns: frontend/src/App.jsx, frontend/src/components/ (new files:
Board.jsx, JobDetail.jsx; CallScreen.jsx edits only to disable camera),
frontend/src/styles.css.

```
You are working in the etai repo (read AGENTS.md, docs/dispatch-prompts.md,
and docs/frontend.md first). Rebuild the frontend as a dispatcher console
for trade contractors (locksmith/plumber/electrician managing clients).
Camera OFF -- do not call getUserMedia video anywhere.

Layout (one screen, the existing Ambiguous-style tokens in styles.css):
- Left sidebar: unified list. Top section "agents" (the existing persona
  list from fetchCoworkers/agents.js -- keep the call-your-agent entry
  point, tapping one opens CallScreen). Below it "customers": one row
  per job -- customer name, job description, status chip
  (confirmed/en_route/done), window time.
- Main pane, selected job: customer name/phone/address, the map slot
  (<MapView> component -- another agent owns it; if absent render an
  address card placeholder), a large distance + ETA readout, and two
  primary buttons:
    "On my way"  -> geolocate via lib/location.currentPosition()
                    (fallback: contractor home base address -> geocode),
                    lookup.route() to the job's geocoded address,
                    notify.etaMessage + sendSms, then
                    jobs.transition(board, id, 'depart'). Show the text
                    that was sent; if via=="none" offer the sms: href as
                    a link.
    "Mark resolved" -> transition 'done'; resolved jobs collapse into a
                    "resolved" group at the bottom of the list.
- State: one board object from lib/jobs.js (loadBoard, seedBoard on
  first run), saved on every transition. App.jsx holds it.

Consume exactly the shared contracts in docs/dispatch-prompts.md --
import those names; if a module is not merged yet, keep the import and
let the build tell us. Do not reimplement ETA math, sendSms, or the
store inside components.

Keep CallScreen reachable from the agent list; strip camera usage (mic
only is fine, or no media at all). Delete UI that no longer serves the
console. Restyle with the existing CSS custom properties -- clean,
information-dense, utilitarian; this is a work tool, not a demo toy.

Verify: cd frontend && npm run build && npm test. The board loads with
seed data, depart sends (or falls back) and flips status to en_route,
resolve moves the job to the resolved group, all without an API key.
```

PROMPT 5 -- map view
--------------------

Owns: frontend/src/components/MapView.jsx, frontend/package.json (dep).

```
You are working in the etai repo (read AGENTS.md; KISS -- the zero-dep
option is preferred if it holds).

The job detail pane needs a map showing the customer address marker,
and the contractor's position when known. API: <MapView customer={{lat,
lon, label}} contractor={{lat, lon} | null} />.

Option A (preferred, zero deps): an <iframe> to
openstreetmap.org/export/embed.html with a bbox computed around the
marker(s) and ?marker=lat,lon. One marker only -- acceptable per the
product call that distance matters more than visuals.
Option B (only if A proves too limited): leaflet + OSM tiles, fit
bounds to both markers. Add leaflet via npm with a pinned version
published at least a week ago.

Component stays dumb: props in, map out, no fetching. Used by the
dispatcher UI agent's JobDetail; keep the props above stable.

Verify: cd frontend && npm run build.
```

PROMPT 6 -- inbound customer replies (optional, backend)
--------------------------------------------------------

Owns: agent/index.js, agent/intent.js (extend), agent/tests/.

```
You are working in the etai repo (read AGENTS.md, docs/AGENT.md,
docs/PHONE.md). Extend the agent service so customer replies update job
state: an inbound text from a customer threadKey with "ok"/"thanks" is
acknowledged; "where are you" re-sends the last ETA for their active
job; "cancel" cancels their next confirmed/en_route job and notifies the
contractor. Persist via the existing .state.json mechanism. Customers
are matched by phone on their Job/Customer records.

Verify: root npm test.
```

NOTES
-----

- No new secrets: VITE_MESSAGING_URL goes in frontend/.env.local,
  gitignored, default unset = offline fallback works.
- The frontend never calls Ambiguous outside api/ambiguous.js and never
  calls messaging outside api/notify.js.
- user-interface/ stays empty; frontend/ is the real UI.
