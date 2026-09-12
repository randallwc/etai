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
  failed and the caller may retry.

Receive messages -- POST {MESSAGING_URL}/subscriptions

    { "url": "https://your-agent/webhooks/inbound" }
    -> 200 { "subscribed": "...", "subscribers": 1 }

  Subscribe once at startup. Every inbound message is then POSTed to every
  subscriber as the normalized shape in models/phone-contract.schema.json
  ($defs.inboundMessage): channel, from, body, externalId, receivedAt,
  threadKey. Fanout is fire-and-forget -- if your endpoint is down the
  message still exists in the service's recent log (GET /messages) but is
  not redelivered, so subscribe before traffic starts.

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
GET /healthz -- { ok, transport, subscribers }.

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
  CARRIER_GATEWAY       defaults to vtext.com
  MAIL_POLL_SECONDS     inbox poll interval (default 15; 0 disables)
  MAIL_POLL_LIMIT       inbox page size per poll (default 20)

Transport selection: bluebubbles (both vars) -> ambimail (AMBIG_API) ->
sim. ambimail delivers outbound texts by sending Ambiguous workspace mail
to <number>@vtext.com -- real SMS delivery, no Mac required, but only for
Verizon numbers and only until Verizon retires the gateway (~March 2027).
Inbound replies DO come back, but through the mail inbox poller described
below -- they are SMS replies landing as email, not iMessages. With
neither configured the sim transport logs outbound texts to stdout and
returns sim-* ids, which keeps every dependent agent fully testable.

TESTING THE iMESSAGE PATH
-------------------------

Local, no hardware: run the service, POST /subscriptions a local URL (or
run `nc`/any logger), then POST /simulate/inbound and /send. The wire
shape is identical to the real path -- only the transport differs.

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
from ordinary addresses is logged once and skipped; it is left unread so
a human still sees it.

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
collapses an email that arrives twice.

GOTCHAS
-------

BlueBubbles echoes our own sends as new-message events with isFromMe=true;
they are filtered before fanout or your agent will answer itself.

Dedup is on externalId and in-memory -- a service restart re-accepts the
same guid once. Providers do retry, so subscribers should also dedup.

BlueBubbles takes its password in the URL query string; never log outbound
request URLs.

threadKey is the counterparty phone, not the provider chat guid -- keeps
threads stable across transports.
