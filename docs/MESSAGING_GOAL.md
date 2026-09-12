MESSAGING GOAL -- triggers and who gets messaged
================================================

Read this before touching agent/ or messaging/. It defines the three
trigger sources, what each does, and who gets texted. The wire contract
stays docs/PHONE.md; the loop internals are docs/agent.md. This file is
the behavior spec other agents build against.

DEMO DATA
---------

scripts/seed-calendar.js writes 5 fake jobs onto the real Ambiguous
calendar (default calendar, America/Los_Angeles): 3 today, 1 tomorrow.
Run it with .env loaded. Reschedule/cancel triggers need a job to exist
-- seed first, always.

THE THREE TRIGGER SOURCES
-------------------------

1. CLIENT trigger -- inbound text from a number that is not
   CONTRACT_PHONE. Thread key is the client's phone.

   "need sprinklers fixed thursday"
     -> intent book -> proposeSlots -> text back 3 options
     -> client replies "1" / "second" / "9am works" -> createEvent
     -> text client "Locked in ..." AND text contractor "New booking ..."

   "move it" / "can you do friday instead"
     -> intent reschedule -> proposeSlots -> pick -> updateEvent
     -> text client "Done -- moved to ..." AND contractor "...moved by
        the client"

   "cancel"
     -> intent cancel -> cancelEvent on their job
     -> text client "Canceled ... say so to rebook" AND contractor
        "Client canceled ... -- that slot is free"
     -> the freed slot is now an OPEN SPOT (see below)

2. CONTRACTOR trigger -- inbound text from CONTRACT_PHONE.

   "running 20 late"
     -> intent running_late -> shift next job -> text THE CLIENT on that
        job the new ETA; contractor gets "Updated -- shifted ... and let
        them know"

   "cancel the next one"
     -> cancelEvent -> text that job's client "...needs to be canceled.
        Reply here and I'll find you a new time" (client reply re-enters
        the booking flow)

   "what's my day" -> digest of today's route, contractor only.

   Anything else from the contractor -> createTask on the Ambiguous
   workspace (parts to order, callbacks). Client "other" texts get a
   help line, never a task.

3. TIME trigger -- the clock, via agent/reminders.js (60s tick) and
   /internal/digest.

   - REMINDER_LEAD_MINUTES before each confirmed job -> text contractor
     "Next up: <job> at <time>. Reply 'running N late' and I'll update
     them." Once per job.
   - Morning digest: POST /internal/digest -> day_summary text to
     contractor. Cron or manual curl for the demo.
   - OPEN SPOT (the important one): when a slot frees up -- client
     canceled, contractor canceled, or a job moved off a time -- the
     agent should text affected or waiting clients an offer: "an
     earlier spot opened Thu: 1) 9am 2) 10:30 3) 2pm. Reply with a
     number." It reuses the pendingProposal machinery with mode
     "reschedule" (or "book" for waitlisted clients), so a numeric reply
     books straight onto the freed time.

MESSAGE ROUTING RULES
---------------------

  - threadKey is always the counterparty phone. Contractor thread and
    client threads are separate; cross-notifications are explicit sends
    to the OTHER party, not thread moves.
  - Only jobs the agent booked carry a client phone (job ->
    customer.phone). Events created by hand have no client link -- the
    contractor is told, no client text goes out.
  - Every outbound text goes through notify() -> messaging /send. Never
    call the transport directly from agent code.
  - Every tool call lands in the AgentAction log (store.actions); a
    failure becomes "couldn't reach the calendar, try again in a
    minute", never a stack trace at the user.

DEMO SEQUENCE (seeded data)
---------------------------

  1. Client texts "need sprinklers fixed thursday" -> 3 options -> "1"
     -> Locked in + contractor notified.
  2. Contractor texts "running 20 late" -> next seeded job shifts,
     client gets new ETA.
  3. Contractor texts "cancel the next one" -> client gets cancel +
     rebook offer; freed slot becomes an open spot offer.
  4. curl -X POST :4030/internal/digest -> contractor gets the day route.
  5. Wait for a seeded job inside REMINDER_LEAD_MINUTES -> contractor
     gets the heads-up text automatically.
