DEMO DAY -- the runbook
=========================

Owner: demo team. This file exists because the sequence spans
messaging, bus, and frontend and no single component doc can hold it.
Read docs/messaging.md and docs/bus.md for the contracts; this is only
the order of operations.

THE PHONES
----------

  - Contractor handset: +15550100101 (AT&T). CONTRACT_PHONE in .env;
    the bus treats texts from this number as "the boss" and sends
    digests, booking notices, and reminder heads-ups here.
  - Client handset: +15550100100 (Verizon). CLIENT_PHONE in .env; the
    customer side of the demo. The console also reroutes its outbound
    texts to this number via VITE_DEMO_PHONE.

ENV FILES
---------

Repo .env (gitignored, loaded by every service via shared/env.js):

  AMBIG_API               workspace ak_ key. Powers the ambimail
                          transport, the mail poller, and the bus
                          calendar + classifier. AMBIGUOUS_API_KEY is
                          an accepted alias; set one, keep them equal.
  AMBIGUOUS_BASE_URL      https://app.ambiguous.ai (default, optional)
  CONTRACT_PHONE          +15550100101
  CLIENT_PHONE            +15550100100
  CONTRACTOR_TZ           America/Los_Angeles
  MESSAGING_URL           http://localhost:4020 (bus -> messaging)
  UPSTREAM_URL            http://localhost:4010 -- messaging seeds the
                          bus as its inbound subscriber. Alternative:
                          leave it empty and set PUBLIC_URL to the
                          same URL so the bus self-subscribes. Use ONE
                          mechanism; two subscribers means every text
                          gets answered twice.
  BUS_URL                 http://localhost:4010 (scripts + pollers)
  CARRIER_GATEWAYS        JSON map of E.164 -> gateway domain, checked
                          per recipient. The two demo handsets:
                          '{"+15550100100":"vtext.com","+15550100101":"txt.att.net"}'
                          Keep it single-quoted in .env (shared/env.js
                          strips the quotes; a shell would eat them).
  CARRIER_GATEWAY         vtext.com -- fallback for unlisted numbers;
                          wrong gateway = silent drop, see below
  MAIL_POLL_SECONDS=15, MAIL_POLL_LIMIT=20   defaults are fine
  STATE_FILE              unset -> bus/.state.json
  REMINDER_LEAD_MINUTES   30

frontend/.env.local (gitignored; restart vite after edits):

  VITE_AMBIGUOUS_API_KEY  same ak_ key -- roster, day summary, tasks,
                          transcript handoff
  VITE_AMBIGUOUS_BASE     /api -- vite dev proxy to app.ambiguous.ai
  VITE_MESSAGING_URL      http://localhost:4020 -- console "on my way"
                          texts
  VITE_DEMO_PHONE         +15550100100 -- reroutes every console text to
                          the client handset, and is the caller id
                          (from) for call turns through the bus
  VITE_BUS_URL            http://localhost:4010 -- call turns go to
                          POST /voice/turn; unset, the call falls back
                          to the local Ambiguous path and still works

START ORDER
-----------

Order matters: messaging before bus so the inbound subscription has
somewhere to land; frontend last.

  1. make run-messaging   (:4020)
       curl localhost:4020/healthz
       -> {"ok":true,"transport":"ambimail","subscribers":1}
     transport must be "ambimail". "sim" means the Ambiguous key did
     not load; "bluebubbles" means BlueBubbles vars are set and win.
     subscribers is 1 once UPSTREAM_URL seeds the bus (or the bus
     self-subscribes via PUBLIC_URL).
  2. make run-bus         (:4010)
       curl localhost:4010/healthz
       -> {"ok":true,"stub":false,"ambiguous":true,"messaging":true,...}
     ambiguous:true plus stub:false means the real Ambiguous calendar
     and classifier. Note messaging:true only proves MESSAGING_URL is
     set -- the real proof of the link is subscribers>=1 on the
     messaging healthz above, or an end-to-end text.
  3. cd frontend && npm run dev   (vite default :5173; open the URL it
     prints). The board loads seeded jobs; the etAI agent sits in the
     sidebar list.

THE THREE DEMO PATHS
--------------------

1. Real SMS, both directions. Inbound only works as a REPLY to an
   ambimail text -- a client texting a fresh number reaches nothing. So
   kick it off server-side: POST :4020/simulate/inbound with
   {"from":"+15550100100","body":"need sprinklers fixed tomorrow"} and
   the bus proposes slots as a real text on the client handset. Reply
   "1" on the phone; the reply lands in the Ambiguous mail inbox, the
   poller picks it up within a poll interval, and the handset gets the
   "Locked in" text. To push outbound first instead, curl -X POST
   :4010/internal/client-update texts each client their next booking.
   GET :4020/messages shows the recent inbound log when a reply seems
   lost.

2. Sim chat, the no-signal fallback. `make chat` spawns messaging on
   the sim transport plus the bus wired together on ephemeral ports;
   each line you type is a text in, agent replies print back. `/as
   client` or `/as contractor` switches which handset you are playing,
   `/quit` exits. The bus still uses the real Ambiguous key for
   classify and calendar, so every flow works with zero cell coverage.
   `make demo` runs the same wiring as a scripted four-flow regression.

3. Web console call. In the sidebar tap the etAI agent to open
   CallScreen. Each turn POSTs {VITE_BUS_URL}/voice/turn with
   from=VITE_DEMO_PHONE and the reply is what the agent says -- same
   brain, same thread state as SMS, so a slot offered on the call can
   be confirmed by a later text. On the board, "On my way" geolocates,
   computes the ETA, and texts the client handset through messaging
   /send; "Mark resolved" flips the job to done. With no key or no bus
   the console still runs on seed data and local replies.

RESET BETWEEN TAKES
-------------------

  1. Bus state: stop the bus, `rm bus/.state.json`, restart. That
     clears threads, jobs, dedup, and the action log so a re-take does
     not answer "1" against a stale proposal.
  2. Board: devtools console -> localStorage.removeItem("etai.board.v3")
     -> reload; the seed board comes back. Clearing site data does the
     same thing.
  3. Ambiguous calendar: seeded jobs are real events on the default
     calendar and survive restarts. List them with
       npx ambiguous api GET "/api/calendars/events?start=<iso>&end=<iso>"
     and delete each with
       npx ambiguous api DELETE /api/calendars/events/<id>
     then re-run `node scripts/seed-calendar.js` for a fresh five jobs
     (3 today, 2 tomorrow, America/Los_Angeles). Booking takes also
     leave behind the events the agent created -- delete those too or
     open availability shrinks take over take.

LATENCY AND THE SILENT-DROP GOTCHA
----------------------------------

  - assistant/chat classify runs ~10-30 s per turn (verified live). The
    bus Ambiguous client timeout is 60 s; do not lower it. A turn that
    looks stuck is usually just classifying -- wait before retrying.
  - Inbound SMS replies are seen at most one poll interval
    (MAIL_POLL_SECONDS, default 15 s) after they land in the workspace
    inbox, plus the carrier's email-to-SMS hop on top. Talk over the
    gap; do not re-send mid-flight.
  - Silent drop: ambimail delivers by mailing <number>@<gateway>. A
    wrong gateway means the carrier deletes the mail with no error and
    no delivery receipt -- the demo already lost a take to an AT&T
    gateway vs a Verizon phone. CARRIER_GATEWAYS routes each known
    number to its carrier (client handset vtext.com, contractor handset
    txt.att.net); a number missing from the map falls back to
    CARRIER_GATEWAY and drops if that is the wrong carrier. If a
    handset stops receiving mid-demo, check the map entry for that
    number before anything else.
  - Quick triage: transport "sim" on messaging healthz = key not
    loaded; stub:true on bus healthz = no Ambiguous key; subscribers:0
    = the bus is not subscribed, restart order was wrong or
    UPSTREAM_URL/PUBLIC_URL is unset.
