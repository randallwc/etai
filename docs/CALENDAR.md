CALENDAR -- service contract
============================

Owner: calendar team. Consumer: the agent service.

Implementation note: the live calendar-agent currently resolves scheduling
requests through Ambiguous Assistant chat (POST /api/assistant/chat, see
docs/calendar-agent.md) rather than raw event endpoints. This document stays
the contract of what the agent service needs; how the calendar side
satisfies it (Assistant chat vs direct event API) is the calendar team's
choice -- the shapes below are what flows between us either way.

This document is the entire contract. The agent needs five operations:
check availability, list a day, create an event, update an event, cancel an
event. Everything Ambiguous-specific -- auth, endpoint paths, quota,
workspace membership -- lives behind this surface.

BASE URL
--------

The service listens on CALENDAR_SERVICE_URL. All paths below are relative to
it. If the calendar team ships an in-process TypeScript module instead of a
service, implement the CalendarProvider interface at the bottom of this file
with identical semantics and skip HTTP entirely. Pick one; do not do both.

DATA SHAPES
-----------

TimeWindow -- an open slot inside working hours:

    { "start": "2026-09-14T09:00:00-07:00", "end": "2026-09-14T10:30:00-07:00" }

CalendarEvent -- a booked job on the contractor's calendar:

    {
      "id": "evt_8f3a",
      "start": "2026-09-14T10:00:00-07:00",
      "end": "2026-09-14T11:00:00-07:00",
      "title": "Sprinkler repair - Alvarez",
      "description": "Replace valve, client texts ok",
      "address": "412 Willow St",
      "status": "confirmed"
    }

status is one of: confirmed, en_route, done, canceled. The id is whatever
Ambiguous returns -- opaque to us, stored on the Job as ambiguousEventId.

Timestamps always carry an offset. The date query param is the contractor's
local day. The service owns every conversion Ambiguous requires.

ENDPOINTS
---------

POST /calendar/availability
  Find open windows on the contractor's calendar for a local day.

  Request:
    { "date": "2026-09-14", "durationMinutes": 60 }

  Response 200:
    { "windows": [ { "start": "...", "end": "..." } ] }

  Empty windows is a normal answer, not an error. Availability is computed
  only over the contractor's calendar -- clients have no calendar in this
  system.

GET /calendar/events?date=YYYY-MM-DD
  List the contractor's events for a local day, ordered by start. Feeds the
  morning digest and "what's my day".

  Response 200:
    { "events": [ CalendarEvent, ... ] }

POST /calendar/events
  Create an event.

  Request:
    {
      "title": "Sprinkler repair - Alvarez",
      "start": "2026-09-14T10:00:00-07:00",
      "end": "2026-09-14T11:00:00-07:00",
      "description": "...",
      "address": "412 Willow St",
      "customerName": "Rosa Alvarez",
      "customerPhone": "+15551234567"
    }

  Response 200: the created CalendarEvent.

PATCH /calendar/events/{id}
  Update an event. All fields optional; used for reschedule, status changes
  (en_route, done), and note edits.

  Request:  { "start": "...", "end": "...", "status": "en_route" }
  Response 200: the updated CalendarEvent.

POST /calendar/events/{id}/cancel
  Cancel an event. Idempotent -- canceling an already-canceled event returns
  200 with the canceled event, not an error.

  Request:  { "reason": "client canceled" }
  Response 200: the canceled CalendarEvent.

ERRORS
------

Non-2xx responses carry { "error": { "code": "...", "message": "..." } }.

  conflict    the requested window overlaps an existing event (agent will
              offer the next window from get_availability instead)
  not_found   event id unknown
  invalid     request failed validation (bad date, end before start)
  upstream    Ambiguous itself failed -- safe for the agent to retry once
  auth        credentials rejected -- page the calendar owner, not retryable

CONFORMANCE CHECKLIST
---------------------

  curl -s $CALENDAR_SERVICE_URL/calendar/events?date=2026-09-14
    -> 200, { "events": [] } on an empty day

  curl -s -X POST $CALENDAR_SERVICE_URL/calendar/events \
    -H 'content-type: application/json' \
    -d '{"title":"T","start":"2026-09-14T10:00:00-07:00",
         "end":"2026-09-14T11:00:00-07:00","description":"d",
         "address":"a","customerName":"n","customerPhone":"+15551234567"}'
    -> 200, event with an id

  curl -s -X POST $CALENDAR_SERVICE_URL/calendar/availability \
    -H 'content-type: application/json' \
    -d '{"date":"2026-09-14","durationMinutes":60}'
    -> 200, windows not overlapping the event just created

  Repeat the create with an overlapping window -> 409 conflict shape.
  Cancel the same event twice -> 200 both times.

AMBIGUOUS IMPLEMENTATION NOTES
------------------------------

Getting credentials. Create a free workspace at https://app.ambiguous.ai,
add the contractor as a member (availability checks are member-centric --
the contractor must be a workspace user, not a contact). Admin -> API keys
issues an ak_ token. Agents can be provisioned via one API call if you want
the agent to act under its own identity rather than the contractor's.

Three equivalent clients, pick whatever is fastest:

  - @ambiguous-ai/api-client (typed TS client, npm)
  - the `ambiguous` CLI: `npx ambiguous auth login --token ak_...`, then
    e.g. `npx ambiguous calendar availability --user-ids <id> --start
    <iso> --end <iso> --json`; `npx ambiguous api <METHOD> /api/<path>
    --data '<json>'` is the escape hatch to any endpoint
  - raw REST against https://app.ambiguous.ai with the ak_ token

Verify at setup, before writing the service -- the docs are thin and the
spec is the truth:

  - fetch the live OpenAPI spec (the CLI builds itself from it; try
    https://app.ambiguous.ai/openapi.json) and note the real event paths
  - whether ordinary CRUD calls consume the free tier's 1,000 monthly
    "AI actions"
  - whether provisioned agent identities count against the 5-seat cap
  - the MCP server URL, if you prefer MCP over REST

Beyond calendar. The same workspace gives CRM (customer records -- back
upsert_customer with `ambiguous crm`), Tasks (job tickets), and webhooks if
we later want the workspace to push changes to us. Using them is your call;
the contract above does not require them.

Limits of the platform. The Ambiguous calendar is standalone -- no Google or
Outlook sync, only one-way .ics export. Events the agent creates will not
appear on anyone's personal calendar.

IN-PROCESS ALTERNATIVE
----------------------

If this ships as a module inside the agent service instead of a service,
implement this interface with the same semantics:

    interface CalendarProvider {
      getAvailability(i: { date: string; durationMinutes: number }): Promise<TimeWindow[]>;
      listDay(i: { date: string }): Promise<CalendarEvent[]>;
      createEvent(i: CreateEventInput): Promise<CalendarEvent>;
      updateEvent(i: { eventId: string; start?: string; end?: string;
                       description?: string; status?: EventStatus }): Promise<CalendarEvent>;
      cancelEvent(i: { eventId: string; reason?: string }): Promise<CalendarEvent>;
    }

Throw a typed CalendarError carrying the same code values as the HTTP error
contract.
