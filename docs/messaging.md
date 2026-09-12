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

Transport selection: bluebubbles (both vars) -> ambimail (AMBIG_API) ->
sim. ambimail delivers outbound texts by sending Ambiguous workspace mail
to <number>@vtext.com -- real SMS delivery, no Mac required, but only for
Verizon numbers and only until Verizon retires the gateway (~March 2027).
Inbound replies do NOT come back through ambimail -- pair it with a real
transport or expect one-way texts. With neither configured the sim
transport logs outbound texts to stdout and returns sim-* ids, which keeps
every dependent agent fully testable.

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
