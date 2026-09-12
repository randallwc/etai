Ambiguous.ai integration notes
==============================

What Ambiguous is
-----------------

Ambiguous is a workspace for human-AI collaboration. Seventeen apps (Docs,
Sheets, Slides, Wiki, Mail, Chat, Forms, Sign, Tasks, Calendar, CRM, Drive,
Identity, Assistant, Admin, Automations) where every feature has both a
human UI and an agent endpoint. Agents are "AI coworkers": each gets its
own account, an email on the workspace domain, a calendar, and an API key.

Authentication is a Bearer token on every request:
https://app.ambiguous.ai/api with "Authorization: Bearer ak_...". Keys are
minted by "npx ambiguous auth signup" (writes ./.ambi/config.json) or from
the admin console at app.ambiguous.ai/admin. There is also an MCP endpoint
at https://app.ambiguous.ai/mcp carrying the same tool surface.

What we actually call
---------------------

All calls go through frontend/src/api/ambiguous.js. Verified live
2026-09-12 against workspace etai-workspace.ambi.cc.

GET /api/users returns {data: [...]}. Items carry id, type ("agent" or
"human"), username, display_name, workspace_email, avatar_url. We filter
type "agent" to build the callable roster; display_name becomes the
persona name.

GET /api/calendars returns {data: [...]} with id, name, is_default,
timezone. The default calendar is where we book.

GET /api/calendars/events?start=&end= returns {data: [...]} of events
with title, start_at, end_at (UTC ISO), attendees. Used for the day
summary.

GET /api/calendars/availability?user_ids=&start=&end= returns
{availability: {userId: [busySlots]}}. Empty array means free. Used
before booking so meetings land on open time.

POST /api/calendars/:calendar_id/events with {title, start_at, end_at,
attendees: [{user_id}]} creates the meeting. The organizer is added as an
attendee automatically.

POST /api/tasks with {title} returns {task: {...}} - note the task object
is wrapped in a "task" key, not returned bare.

POST /api/documents with {type: "doc", title, content} stores the call
transcript. Content accepts a markdown-ish string and wraps it into block
JSON server-side. This is our end-of-call validation handoff: the
transcript lands in the workspace where any coworker can read it.

The booking packet (verified live 2026-09-12)
---------------------------------------------

When a booking lands, bus/packet.js creates the paperwork:

POST /api/forms {title, description, fields, is_published: true} returns
the form with slug and workspace_slug. Field types are fixed:
short_text, long_text, number, email, phone, date, time, select,
multi_select, rating, scale, file_upload, section, payment. The public
fill page is https://app.ambiguous.ai/f/{workspace_slug}/{slug}; the
unauthenticated read is GET /api/forms/w/{workspace}/{slug} and
submissions POST to .../submit with {data: {fieldId: value}}. We read
results via GET /api/forms/{id}/responses. We text the fill link to the
customer at booking time.

POST /api/sign {title, source_type: "doc", source_doc_id} creates a
draft and renders a PDF. POST /api/sign/{id}/signers {email, name} adds
a signer (agents cannot BE signers). POST /api/sign/{id}/fields places
fields with normalized 0-1 coordinates (x, y, w, h each <= 1, page is
1-based). POST /api/sign/{id}/prepare-send moves draft ->
preview_pending. The final POST /api/sign/{id}/confirm-send returns
CONFIRM_REQUIRES_HUMAN - legally binding sends need a human tap, so we
leave the doc prepared in the Sign UI. List route is GET /api/sign;
GET /api/sign/{id} is the item route (GET /api/sign/documents 404s as a
bad UUID - do not guess a /documents suffix).

POST /api/crm/deals {title, contact_id, primary_contact_id} creates an
open deal (pipeline/stage optional). POST /api/crm/activities
{type: "note", contact_id, deal_id, subject, body} logs the booking on
the contact timeline. POST /api/tasks accepts contact_id, deal_id, and
due_date for linked follow-ups.

POST /api/calendars/{id}/publish returns a public .ics feed_url. Not
used: it exposes the contractor's whole calendar, not just one job.

Gotchas
-------

A fresh workspace is "provisional" until the human owner clicks the
verification link sent at signup. Provisioning more agents
(POST /api/admin/users/provision-agent) returns 403 workspace_provisional
until then. The primary agent works immediately - tasks, calendar, docs,
chat all function.

coworkers dispatch requires a coworker_service_id, which only exists on
persona-backed coworkers created after verification. The signup agent has
an empty coworker_service_id and dispatch returns coworker_not_found. So
for now we act AS the workspace agent rather than dispatching TO a
coworker.

List endpoints paginate with {data, total, has_more}; day-summary code
tolerates absent fields.

POST /api/assistant/chat is live (see assistant-chat-response schema)
and wired into handleRequest: non-scheduling text goes to the
Assistant, which answers with its own workspace tools; on failure the
request falls back to creating a task. Scheduling stays on the
deterministic primitive path (resolve attendee, check availability,
create event) because it owns the travel/weather/working-hours checks
and avoids the Assistant's ~30s agentic-loop timeout noted in
docs/calendar-agent.md.

Approaches considered
---------------------

MCP was rejected for the call UI: it is a tool-calling transport for
agent runtimes, not a request/response API a browser should hold a key
for. The CLI shells out per call and cannot run in the browser. Plain
REST over fetch won - one module, no dependencies.

Storing the transcript as a task was considered; a document won because
the transcript is prose meant for review, and documents render natively
in the Ambiguous UI.

Adding more personas
--------------------

Once the human verifies the workspace, run:

  npx ambiguous api POST /api/admin/users/provision-agent \
    -d '{"display_name": "Nova"}'

per persona. They appear in GET /api/users with type "agent" and the app
picks them up on next load - no code change needed.
