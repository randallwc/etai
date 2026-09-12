AGENT -- the scheduling brain
=============================

agent/ is the service that answers texts and voice turns. Messaging
delivers normalized inbound messages to it; it decides what the sender
wants, calls Ambiguous through its own client, and replies. Client-
originated changes always notify the contractor; contractor-originated
changes notify the affected client. There is no UI and no chat state
beyond per-thread records (pending slot proposals, last intent).

MODULES
-------

  index.js      HTTP + wiring. createAgentServer(env, overrides) builds
                Ambiguous, calendar, ai, store, loop, notify; every piece
                is injectable for tests. Run: node index.js (:4030).
  loop.js       The brain: normalized message -> intent -> calendar
                tools -> reply. Owns the business logic and the exact
                reply text. Exports parseChoice/fmtTime/fmtDay helpers.
  ai.js         Intent classification via Ambiguous assistant/chat --
                asks for a JSON intent object (models/intent.schema.json)
                and extracts it with a tolerant parser. Any failure or
                unparseable response falls back to {intent:"other"}, so
                the loop always gets a shape it can switch on.
  calendar.js   The calendar framework: listDay, proposeSlots,
                createEvent, updateEvent, cancelEvent, plus timezone
                helpers (resolveDayRef, partsInTz, findSlots). With no
                Ambiguous key it returns an in-memory stubCalendar, so
                tests and offline demos exercise the same interface.
  state.js      createStore(file|null): threads, jobs, customers, dedup
                set, and the AgentAction tool log. file=null is
                memory-only for tests; a path persists to JSON on every
                mutation so restarts keep half-finished bookings.
  reminders.js  Polls the job list and texts the contractor a heads-up
                inside REMINDER_LEAD_MINUTES of each job ("running N
                late" hooks the running-late flow). Fires once per job.
  ambiguous.js  The ONLY file that fetches Ambiguous (backend mirror of
                the frontend's src/api/ambiguous.js boundary rule).

ENDPOINTS
---------

POST /webhooks/inbound -- the normalized message shape from
models/phone-contract.schema.json. Dedups on externalId, answers 202,
then processes async. This is the subscription target messaging/ fans
out to; never block it on the LLM or Ambiguous.

POST /voice/turn -- the voice integration seam. Body:

    { "from": "+15551234567", "body": "what the caller said",
      "threadKey": "+15551234567",      optional, defaults to from
      "externalId": "call-42-turn-3" }  optional; pass one per turn to
                                        dedup retries, else generated

    -> 200 { "reply": "the text to speak back to the caller" }

  The caller is on the phone, so the reply is returned in the body and
  NOT texted to them. Notifications to the OTHER party still go out
  over messaging: a contractor saying "running 20 late" on a call gets
  the spoken confirmation back while the client receives the new-ETA
  text. Same intents, same thread state as SMS -- a slot proposal made
  by voice can be confirmed by a later text and vice versa.

POST /internal/digest -- texts the contractor the day's route
(CONTRACT_PHONE). Wire to a cron or hit it manually in the demo.

GET /healthz -- { ok, stub, ambiguous, messaging }.

INTENTS
-------

ai.js classifies into: book, reschedule, cancel, running_late,
day_summary, other. Entities extracted when present: dayRef
(today/tomorrow/weekday name), timePref, durationMinutes, delayMinutes,
name. The loop then:

  book        -> proposeSlots offers up to 3 open times; the reply picks
                 by number, ordinal, or clock time ("9am works"). Books
                 the event, replies "Locked in", texts the contractor.
  reschedule  -> same proposal flow; on pick, updateEvent moves the
                 existing Ambiguous event; counterparty notified.
  cancel      -> cancelEvent; the other party is told the slot is free
                 and offered rebooking.
  running_late-> updateEvent shifts the next job by delayMinutes; the
                 client gets the new ETA text.
  day_summary -> listDay formatted as a route line.
  other       -> contractor's message becomes an Ambiguous task; a
                 client gets a short help text.

Working hours are 9-17 with 90-minute spacing in findSlots; jobs
default to 60 minutes. Hackathon-simple constants, easy to change.

ENV
---

  PORT                 listen port (default 4030)
  MESSAGING_URL        messaging service base URL (send + subscribe)
  PUBLIC_URL           this service's reachable URL for the subscription
  AMBIG_API            Ambiguous ak_ key; unset -> stub calendar in memory
  AMBIGUOUS_BASE_URL   defaults to https://app.ambiguous.ai
  CONTRACT_PHONE       contractor's E.164 number: identifies "the boss",
                       digest + reminder target
  CONTRACTOR_TZ        IANA tz for slot math (default America/Los_Angeles)
  STATE_FILE           JSON persistence path (default agent/.state.json)
  REMINDER_LEAD_MINUTES heads-up window (default 30)

The entry point loads repo-root .env via shared/env.js. With
MESSAGING_URL unset, outbound replies are logged instead of sent.

GOTCHAS
-------

Dedup runs on both sides of fanout: messaging/ dedups before POSTing,
the agent dedups again on receipt. Voice turns get a generated
externalId unless the caller passes one; retries with the same id get
{reply:"", duplicate:true}.

Ambiguous availability is member-centric: busy slots exist only for the
contractor's workspace user. Client calendars are never consulted;
clients just pick from what the contractor has open.

The booking flow is two-phase per thread: a pendingProposal in thread
state holds the offered slots until the reply arrives, and the reply
parser must handle "1", "second", and "9am works" alike. Slot times are
compared in the contractor's timezone, not the server's.

Late and cancel flows text the client only for jobs booked through the
agent (the job record links the Ambiguous event id to the customer's
phone). Events created elsewhere have no client phone, so the
contractor still gets confirmation but no client text goes out.

Tool failures never reach the user as errors: the catch in handle()
replies "couldn't reach the calendar, try again in a minute" and the
failed call is logged in the action log.

CRM sync is best-effort. When a client texts to book, the loop also
upserts them into the workspace CRM via ambi.upsertContact (find by
phone through /api/crm/contacts?q=, then PATCH the name or POST a new
person). It runs inside the record() wrapper so it lands in the
AgentAction log as crm_upsert_contact, but its failure is swallowed --
the booking still completes and the error stays in the log. On success
the returned contact id is stored on the customer as ambiguousCrmId,
and later syncs for that phone are skipped.
