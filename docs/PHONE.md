PHONE -- service contract
=========================

Owner: phone team. Counterparty: the agent service.

This contract is implemented by the messaging/ service -- see
docs/messaging.md for run/config details. The wire shapes below are
unchanged.

The boundary is two HTTP endpoints. Inbound: you POST every incoming
message to us in one normalized shape, whatever the transport. Outbound: we
POST every send to you in one normalized shape, and you pick the transport.
BlueBubbles, LoopMessage, Twilio, Vapi -- all of that is your side of the
line. The agent never learns which wire carried a message.

BOUNDARY
--------

  you -> us   POST {AGENT_BASE_URL}/webhooks/inbound      normalized message
  us -> you   POST {PHONE_SERVICE_URL}/send               outbound text
  you -> us   POST {AGENT_BASE_URL}/webhooks/voice-toolcall   stretch, sync

SHARED VOCABULARY
-----------------

Phone numbers are E.164. Timestamps are ISO 8601 with offset. externalId is
required on every inbound message -- the provider's unique id for it
(BlueBubbles message guid, Twilio MessageSid, LoopMessage id). We dedup on
it; a missing or reused externalId will silently eat messages.

INBOUND -- POST {AGENT_BASE_URL}/webhooks/inbound
------------------------------------------------

Fire for every incoming message, SMS, iMessage, or transcribed voice turn.

  Request:
    {
      "channel": "imessage",
      "from": "+15551234567",
      "body": "running 20 late",
      "externalId": "B1A2C3-...",
      "receivedAt": "2026-09-12T14:05:11-07:00",
      "threadKey": "+15551234567",
      "meta": { "chatGuid": "any;-;+15551234567" }
    }

  channel    "imessage" | "sms" | "voice" | "console"
  threadKey  the conversation identity; the counterparty phone is fine.
             Used so the agent can thread replies. Required.
  meta       optional transport detail the agent must not need -- keep it
             for debugging only.

  Response: 202 Accepted, always, once the message is durably deduped. We
  process asynchronously and reply via /send. 4xx only for a malformed body
  -- do not retry those.

Delivery rules for your side: you may redeliver (provider retries, service
restarts); dedup makes that safe. Ordering is not guaranteed and we do not
depend on it. ACK fast -- do the provider->normalize->POST pipeline without
blocking on our processing.

OUTBOUND -- POST {PHONE_SERVICE_URL}/send
-----------------------------------------

We call this for every text the agent sends.

  Request:
    { "to": "+15551234567", "body": "On my way, ETA 10:20",
      "threadKey": "+15551234567" }

  Response 200:
    { "externalId": "provider-assigned-id" }

  Return the provider's real id so the outbound leg can also be deduped and
  logged. 4xx means the send is invalid (bad number) -- we will not retry.
  5xx means transient (provider unreachable) -- we will retry with backoff.
  If you can queue sends during an outage, return 200 and deliver late; a
  late message beats a dropped one in this product.

VOICE -- stretch, two shapes
----------------------------

Simplest: a voice call's transcribed turns arrive as /webhooks/inbound with
channel "voice", and the agent's replies come back through /send for your
TTS leg. The call is just a noisy message thread.

Vapi-native (better if used): Vapi's server URL emits a `tool-calls` event
mid-conversation that must be answered within roughly 7.5 seconds. Forward
it synchronously:

  POST {AGENT_BASE_URL}/webhooks/voice-toolcall
    { "callId": "...", "tool": "book_job", "args": { ... } }
  -> 200 { "result": <tool result object> }

The agent resolves it against the same tools the message loop uses and
answers inline. Tool names/args match the tool list in docs/API.md.

PROVIDER NOTES -- your side of the line
---------------------------------------

BLUEBUBBLES (primary). Runs on a Mac signed into iMessage (macOS 10.15+,
Full Disk Access + Accessibility). REST + webhooks; built-in Cloudflare
tunnel gives a free public HTTPS URL.

  Send:
    POST {bluebubbles}/api/v1/message/text?password=XXX
    { "chatGuid": "any;-;+15551234567", "tempGuid": "<uuid>",
      "message": "..." }

  Receive: register a webhook URL in the BlueBubbles API & Webhooks UI; it
  POSTs events -- you want `new-message` (also `message-updated`, typing).
  Extract sender from the message's handle address and body from its text;
  the message guid is your externalId. Log raw payloads at setup and adjust
  -- field names in this doc are from the docs, not a live capture.

  Gotchas: chatGuid format is `any;-;+<E164>` for direct chats. The
  password rides in the URL query string -- never log request URLs, and
  only call it over the HTTPS tunnel. iMessage has no delivery SLA and no
  delivery receipts on this path; do not block sends waiting for one.

LOOPMESSAGE (no-Mac fallback). Cloud REST + inbound webhooks for real
iMessage. Free sandbox: unlimited messages, max 5 contacts, and it CANNOT
initiate a conversation -- the contact must text the sandbox sender first,
which opens a 24h reply window reset per inbound. Plan demo order around
that: every demo phone texts in once before the agent can ever reach it.

TWILIO SMS (last-resort fallback). Inbound webhook arrives form-encoded:
From, To, Body, MessageSid. Reply via REST
POST /2010-04-01/Accounts/{SID}/Messages.json. Trial account: outbound only
to verified numbers (up to 5), every outbound text prefixed "Sent from a
Twilio trial account -". Do not attempt 10DLC/toll-free mid-hackathon --
registration takes days and upgrading does not skip it.

VAPI (voice, preferred). Outbound call:
  POST https://api.vapi.ai/call
  { "assistantId": "...", "phoneNumberId": "...",
    "customer": { "number": "+15551234567" } }
Server URL events include tool-calls (forward to /webhooks/voice-toolcall),
status-update, transcript, end-of-call-report. $10 free credit, free US
number, no card.

BLAND (voice, simpler). One curl outbound:
  POST https://api.bland.ai/v1/calls
  { "phone_number": "+1555...", "task": "<prompt>", "voice": "..." }
Free start plan, no card. No mid-call tool calls -- fine for "call to
confirm" legs, not for booking during the call.

CONFORMANCE CHECKLIST
---------------------

  # your service accepts our sends
  curl -s -X POST $PHONE_SERVICE_URL/send \
    -H 'content-type: application/json' \
    -d '{"to":"+15551234567","body":"hi","threadKey":"+15551234567"}'
    -> 200 { "externalId": "..." }

  # we accept your inbound (expect 202)
  curl -s -X POST $AGENT_BASE_URL/webhooks/inbound \
    -H 'content-type: application/json' \
    -d '{"channel":"imessage","from":"+15551234567","body":"hi",
         "externalId":"test-1","receivedAt":"2026-09-12T14:00:00-07:00",
         "threadKey":"+15551234567"}'
    -> 202 ; POST it again -> still 202, processed once.
