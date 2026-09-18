NOTES -- unpinned behaviors and future work
===========================================

Two sections: behaviors the deleted tests used to pin down (a
regression here is noticed in review, not by CI), and features cut
for the MVP with their upgrade path. The code is the source of truth
when this and the implementation disagree.

BEHAVIORS
---------

Booking flow (messaging/loop.js)

- Two-phase per thread: a book intent offers up to 3 numbered open
  slots and stores a pendingProposal; the next message picks by
  number ("1"), ordinal ("second"), or clock time ("9am works").
- Missing fields are asked for one at a time: no day or time pref ->
  "what day or time works"; no location -> "the address".
- Stale proposals expire on PROPOSAL_TTL_MS so an old offer cannot be
  consumed by an unrelated new message; proposals whose slots are all
  in the past are dropped.
- findSlots floors at now+15min; working hours 9-17, 90-minute
  spacing, 60-minute default duration, contractor timezone.
- A confirmed pick creates the event, replies "Locked in", and texts
  the contractor.

Other intents

- reschedule reuses the proposal flow; on pick, updateEvent moves the
  existing event and the counterparty is notified.
- cancel cancels the event, tells the other party the slot is free,
  and offers rebooking.
- running_late shifts the next confirmed job by delayMinutes and texts
  the affected client the new ETA.
- day_summary formats the contractor's day as a route line.
- other: a contractor message becomes an Ambiguous task; a client gets
  a short help text.
- Late and cancel client texts only go out for agent-booked jobs
  (the job record links event id to client phone).

State and classification

- dedup on externalId is in-memory and synchronous; calendar
  notifications use "cal:"+id, mail replies "ambmail-<uuid>"; a
  restart re-accepts once.
- ai.js extracts a JSON intent from assistant/chat with a tolerant
  parser and falls back to keyword classification on failure or a
  missing key.
- The per-channel classify prompts (sms, imessage, voice) live in
  ai.js; unknown channels get the sms profile.
- Customer names are learned from intent.name and re-parsed message
  fields; the CRM upsert is best-effort, stores ambiguousCrmId, and
  skips resync once set.
- store persists to STATE_FILE on every mutation when a path is set;
  null path is memory-only.

Concurrency

- Turns enqueue per threadKey so two texts on one thread process in
  arrival order; different threads interleave freely.
- /voice/turn returns the reply in the body (never texts the caller)
  and shares thread state with SMS, so a slot offered by voice can be
  confirmed by text. TURN_TIMEOUT_MS bounds only the caller-facing
  reply; the queued turn still completes and its texts go out.
- The 1.5s "On it" working beat is canceled when the real reply
  lands.

Transports

- ambimail sends POST /api/mail/send to <number>@<gateway>;
  GATEWAY_MAP routes each known 10-digit number to its carrier's
  domain (a wrong gateway silently delivers nothing).
- The mail poller only accepts senders on known carrier gateway
  domains; other mail is logged once, marked read, and skipped.
  Reply bodies are cut at quoted lines, "On ... wrote:" headers,
  separators, and "Sent from my ...".
- /send brands bodies "etAI update: <body>" and passes through bodies
  already carrying the prefix.

Frontend

- CallScreen phases: connecting -> live -> sending -> done, with
  re-dial resetting to connecting.
- A "Is that all" agent message plus a done-signal reply (yes/no/
  that's all/all set/bye and friends) ends the call and hands the
  transcript to sendConversation.
- When the service is unreachable the agent says so instead of
  answering locally; there is no in-browser scheduling fallback.
- sendConversation returns { ok:false } on failure instead of
  throwing.

FUTURE WORK -- cut for the MVP, recover from git history
------------------------------------------------------

- Dispatch board: Board.jsx, JobDetail.jsx, MapView.jsx, jobs/eta/
  location libs, notify + lookup apis, seed.json, GET /state, and
  fetchBoard/fetchCalendarJobs. Restore if a job overview is wanted;
  the service side still tracks jobs/customers in the store.
- Booking paperwork (packet.js): intake form, work order doc, Sign
  draft, CRM deal per booking. The Ambiguous endpoints are verified
  in docs/ambiguous.md.
- BlueBubbles transport + /webhooks/bluebubbles: real iMessage via a
  Mac. ambimail is the surviving text path.
- /webhooks/ambimail push endpoint: the inbox poller covers inbound
  mail; push was redundant.
- /tts endpoint and msedge-tts neural voice: the call UI speaks via
  the browser's speechSynthesis.
- /internal/digest and /internal/client-update manual triggers:
  digest survives inside the loop for contractor day_summary.
- Open-spot re-offer: on cancel/move, clients waiting on that day
  could be offered the freed slot.
- Client-facing updates from remote calendar events: /webhooks/
  calendar only texts the contractor today.
- Non-Verizon inbound channel: ambimail is carrier-gateway based, no
  delivery receipts, gateways die ~March 2027. Twilio is the real
  fallback.
- Multi-agent roster: AGENT is a single object in App.jsx; the old
  agents.js roster and agent switcher are gone.
- CopilotKit agent path for sms/imessage: prototyped on the deleted
  copilot-sms-imessage branch, in git history.
- Broader test coverage beyond the smoke suite: behaviors above are
  the checklist if coverage is ever rebuilt.
- npm audit: 7 vulns on main, 1 critical. Untriaged.
