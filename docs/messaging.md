MESSAGING -- the service other agents text through
==================================================

The messaging/ service owns every transport (iMessage via BlueBubbles,
sim fallback, SMS/voice later). Other agents never touch a provider: they
call two endpoints and subscribe for inbound. This is the implementation
of the boundary defined in docs/PHONE.md.

Run it: `node messaging/index.js` (PORT, default 4020). Zero dependencies.

HOW OTHER AGENTS TALK TO IT
---------------------------

Send a message -- POST {MESSAGING_URL}/send

    { "to": "+15551234567", "body": "ETA 10:20", "threadKey": "+15551234567" }
    -> 200 { "externalId": "..." }

  `to` is E.164. 400 means the request is invalid; 5xx means the transport
  failed and the caller may retry. Every outbound body is branded
  "etAI update: <body>" at this boundary, so all senders produce
  uniformly signed texts; bodies already starting with the prefix pass
  through untouched.

  The carrier gateway must match the recipient's carrier or the ambimail
  email-to-SMS hop silently delivers nothing. GATEWAY_MAP routes known
  numbers to their carrier's gateway; see CARRIER GATEWAYS below.

Receive messages -- POST {MESSAGING_URL}/subscriptions

    { "url": "https://your-agent/webhooks/inbound" }
    -> 200 { "subscribed": "...", "subscribers": 1 }

  Subscribe once at startup. Every inbound message is then POSTed to every
  subscriber as the normalized shape in models/phone-contract.schema.json
  ($defs.inboundMessage): channel, from, body, externalId, receivedAt,
  threadKey. The webhook ack waits for fanout, bounded by FETCH_TIMEOUT_MS
  per subscriber -- a slow endpoint cannot stall the ack past the timeout
  and never blocks delivery to the healthy ones. If no subscriber accepts,
  the message is queued and retried every FANOUT_RETRY_MS up to
  FANOUT_RETRY_MAX times; the queue persists to UNDELIVERED_FILE so a
  restart cannot drop it, and /simulate/inbound still reports 503 so a
  manual caller knows it did not land yet.

  Alternatively set UPSTREAM_URL on the service; it subscribes
  {UPSTREAM_URL}/webhooks/inbound automatically.

PROVIDER ENDPOINTS (called by transports, not by agents)
--------------------------------------------------------

POST /webhooks/bluebubbles -- the BlueBubbles server's webhook target.
Accepts its event envelope; only `new-message` events with isFromMe=false
become inbound messages. Always 202; dedup on the message guid.

POST /simulate/inbound -- test hook. { "from", "body", "channel"? } runs
through the identical normalize -> dedup -> fanout path as a real iMessage,
so the whole integration is exercisable without a Mac.

GET /messages -- last 200 inbound messages, for demo debugging.
GET /healthz -- { ok, transport, subscribers, queued }, plus "allowed"
(the allowlist size, not the numbers) when ALLOWED_FROM is set, and a
"warn" field when CONTRACT_PHONE is missing from that allowlist.

CONFIG
------

The service loads the repo-root .env automatically on start via
shared/env.js (never overrides vars already in the environment). Any
component can do the same with require("../shared/env.js").loadEnv() in
its entry point -- keep it out of library code so tests stay hermetic.

  PORT                  listen port (default 4020)
  UPSTREAM_URL          optional default inbound subscriber
  BLUEBUBBLES_URL       Cloudflare tunnel URL of the BlueBubbles server
  BLUEBUBBLES_PASSWORD  its API password
  AMBIG_API             Ambiguous workspace key (or AMBIGUOUS_API_KEY)
  AMBIGUOUS_BASE_URL    defaults to https://app.ambiguous.ai
  CARRIER_GATEWAY       fallback gateway domain (default vtext.com)
  GATEWAY_MAP           optional per-recipient override keyed on the
                        10-digit number: num:domain[+domain...] entries,
                        comma-separated; every listed domain is tried,
                        only the real carrier delivers
  UNDELIVERED_FILE      on-disk spool for the undelivered retry queue
                        (default /tmp/etai-undelivered.json)
  ALLOWED_FROM          comma-separated E.164 senders to accept;
                        empty accepts everyone; filtered senders get a
                        202 and are never fanned out
  MAIL_POLL_SECONDS     inbox poll interval (default 15; 0 disables)
  MAIL_POLL_LIMIT       inbox page size per poll (default 20)
  FETCH_TIMEOUT_MS      ceiling on every outbound fetch -- subscriber
                        fanout and mail poll calls default 8000,
                        transport sends default 15000
  FANOUT_RETRY_MS       redelivery interval for the undelivered queue
                        (default 5000)
  FANOUT_RETRY_MAX      attempts before a queued message is dropped
                        (default 24)

Transport selection: bluebubbles (both vars) -> ambimail (AMBIG_API) ->
sim. ambimail delivers outbound texts by sending Ambiguous workspace mail
to <number>@vtext.com -- real SMS delivery, no Mac required, but only for
Verizon numbers and only until Verizon retires the gateway (~March 2027).
Inbound replies DO come back, but through the mail inbox poller described
below -- they are SMS replies landing as email, not iMessages. With
neither configured the sim transport logs outbound texts to stdout and
returns sim-* ids, which keeps every dependent agent fully testable.

CARRIER GATEWAYS -- per-recipient ambimail routing
-------------------------------------------------

ambimail delivers by mailing <digits>@<gateway>. A carrier gateway only
delivers to its own subscribers: send an AT&T number to vtext.com and
Verizon accepts the mail, drops the SMS, and reports nothing -- the
/send caller gets a 200 with a real externalId and no error exists on
any side. The demo hit exactly this once (AT&T gateway, Verizon phone,
silence). There is no delivery signal to key off; the only fix is
routing each known number to the right domain.

GATEWAY_MAP is comma-separated num:domain[+domain...] entries keyed on
the 10-digit number, and every listed domain is sent -- only the real
carrier delivers, the rest are silent drops that cost nothing. Pin a
known handset to one domain (4253625633:vtext.com for the Verizon demo
phone, 8177136090:txt.att.net for the AT&T one); blast unknowns with a
domain per likely carrier. Malformed entries (no colon, empty domain
list) are ignored, never a crash. Numbers not in the map fall back to
CARRIER_GATEWAY (default vtext.com).

An earlier CARRIER_GATEWAYS JSON map was removed in favor of
GATEWAY_MAP: the blast format already covers pinned routing by listing
one domain, and keeping one mechanism means one doc, one parser, one
lookup.

TESTING THE iMESSAGE PATH
-------------------------

Local, no hardware: run the service, POST /subscriptions a local URL (or
run `nc`/any logger), then POST /simulate/inbound and /send. The wire
shape is identical to the real path -- only the transport differs.

For a two-way conversation use `make chat` (scripts/chat.js): it spawns
messaging on the sim transport plus the bus wired together, and turns
your terminal into the phone. Each line you type is a text in; agent
replies print as they arrive. `/as client` or `/as <e164>` switches
which side you are texting as. `scripts/demo.js` runs the same wiring
as a scripted five-step regression instead of interactive input.

Real iMessage (needs a Mac signed into iMessage):

  1. Install BlueBubbles server on the Mac; grant Full Disk Access and
     Accessibility; enable the built-in Cloudflare tunnel -> public URL.
  2. In BlueBubbles API & Webhooks settings, set the webhook URL to
     {MESSAGING_URL}/webhooks/bluebubbles.
  3. Export BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD, restart.
  4. Text the Mac's number -- a normalized inbound lands at subscribers;
     POST /send replies as a real iMessage.

If no Mac exists at the venue, the fallback chain is LoopMessage sandbox
(inbound-initiated, 5 contacts) then Twilio SMS (verified numbers only) --
either plugs in as another transport in transports.js and a webhook route;
the normalized contract does not change.

INBOUND VIA MAIL POLLING
------------------------

When a client replies to an ambimail text, the carrier gateway turns the
SMS into an email that lands in the Ambiguous workspace mail inbox, sent
from the number's gateway address (e.g. 4253625633@vzwpix.com). The
mailpoller in messaging/mailpoller.js closes that loop: whenever
AMBIG_API (or AMBIGUOUS_API_KEY) is set it polls
GET /api/mail/inbox?unread=true every MAIL_POLL_SECONDS (default 15),
turns each unread item into a normalized inboundMessage, and feeds it
through the same dedup -> fanout path as the webhook transports.

Phone derivation only accepts sender (or Reply-To) addresses on known
carrier gateway domains -- vtext.com, vzwpix.com, vmobl.com, txt.att.net,
messaging.sprintpcs.com, tmomail.net, and friends, plus whatever
CARRIER_GATEWAY names. A ten-digit local part becomes +1<number>. Mail
from ordinary addresses is logged once, skipped, and marked read so the
unread-only inbox query stops returning it (the human copy still exists
in the mailbox, just not as an unread item). Skipped ids are also
remembered in memory (capped at 5000, oldest evicted) so a failed
mark-read does not re-log the same mail on every poll.

The body is the first non-quoted block of body_text: lines starting with
">", an "On ... wrote:" header, separator runs, or "Sent from my ..."
terminate the reply. Consumed items are acked with
PATCH /api/mail/{id} {read:true}, and dedup keys on externalId
"ambmail-<email uuid>" -- the same prefix the /webhooks/ambimail push
path uses, so an email arriving through both collapses to one emit.

Caveats. This only sees replies to ambimail texts (or anything else that
reached a carrier gateway); a client texting a fresh number reaches
nothing. Latency is up to one poll interval plus the carrier's
email-to-SMS hop. Channel is "sms", not "imessage". The unread filter
plus mark-read ack means a restart does not re-emit, but in-memory dedup
still covers a mark-read failure. Polling is independent of the
/webhooks/ambimail push path; if both are live the shared dedup
collapses an email that arrives twice. Polls are serialized: a poll that
outlasts MAIL_POLL_SECONDS short-circuits the overlapping tick instead of
stacking concurrent inbox scans.

Measured live 2026-09-12 against etai-workspace.ambi.cc: POST /send
returns in ~1.5 s, but the workspace holds each send in an undo window
so sent_at lands ~5.5 s after created_at on every item -- that is when
the carrier actually sees the mail. A simulated inbound answered by the
bus produced the reply mail ~12 s after fanout (bus assistant classify
is most of it), released ~5.5 s later, so in-stack latency is roughly
18 s plus up to one poll interval inbound and both carrier hops. The
reply leg handset -> vzwpix.com -> inbox has not been observed on a real
phone yet; every hop after inbox is verified.

Push instead of poll: Ambiguous exposes POST /api/webhooks with an
email.received event type, https URLs only, and returns an HMAC signing
secret. /webhooks/ambimail already exists on this service and shares the
ambmail- dedup prefix, so registering it is the fast path once the
service has a public https URL (a tunnel works). Until then it is not
registered and the handler does not verify the signature.

END-TO-END CHECK AGAINST THE LIVE STACK
---------------------------------------

`node scripts/e2e-phone.js` verifies the whole ambimail path while the
services are already running: it POSTs a booking text to
{MESSAGING_URL}/simulate/inbound as CLIENT_PHONE, confirms the message in
GET /messages, then polls the Ambiguous workspace's sent folder
(GET /api/mail/sent) until a new item addressed to <number>@vtext.com
appears, and asserts the body starts with "etAI update: ". Each step
prints PASS/FAIL and the process exits nonzero on any failure.

Env vars (all default to the repo .env values):

  MESSAGING_URL          messaging base (default http://localhost:4020)
  BUS_URL                bus base (default http://localhost:4010)
  CLIENT_PHONE           simulated sender, E.164 (default +14253625633)
  CARRIER_GATEWAY        gateway domain matched in the mail To
  AMBIG_API or AMBIGUOUS_API_KEY   workspace key for the mail API
  AMBIGUOUS_BASE_URL     default https://app.ambiguous.ai
  E2E_BODY               the text sent (default a sprinkler booking)
  E2E_HEALTH_TIMEOUT_MS  healthz steps (default 15000)
  E2E_INBOUND_TIMEOUT_MS inbound visibility step (default 15000)
  E2E_MAIL_TIMEOUT_MS    sent-mail poll (default 150000)
  E2E_POLL_MS            poll interval (default 3000)

Expected latency: health and inbound steps are instant; the bus's
assistant classify plus the mail send lands the reply in the sent folder
in roughly 20-35 s, so a full pass takes under a minute. The mail step
snapshots the sent folder first and only accepts new items, so reruns
are safe.

GOTCHAS
-------

POST bodies are capped at 1 MiB; over that the service drains the upload
and replies 413. Malformed JSON gets 400, not 500.

BlueBubbles echoes our own sends as new-message events with isFromMe=true;
they are filtered before fanout or your agent will answer itself.

Dedup is on externalId and in-memory -- a service restart re-accepts the
same guid once. Providers do retry, so subscribers should also dedup.

BlueBubbles takes its password in the URL query string; never log outbound
request URLs.

threadKey is the counterparty phone, not the provider chat guid -- keeps
threads stable across transports.
