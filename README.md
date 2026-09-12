# ETAi

**AI Tinkerers Seattle Hackathon 2026** · [Hackathon page](https://seattle.aitinkerers.org/hackathons/h_GfcjwcUkasM/teams) · [Ambiguous.ai](https://app.ambiguous.ai/settings)

## theme

Agents are leaving the chatbox. Build an agent for a place people
already work, talk, or live, then make it meaningfully more useful
because of that context. Put it into the web, mobile, Slack, Teams,
messaging, browsers, voice, wearables, robotics, or somewhere nobody
expects to find one yet. What becomes possible when the agent shows up
where the work is already happening?

A dispatcher you text. Contractors and clients book, reschedule, and
cancel appointments over iMessage, SMS, and calls; an Ambiguous.ai
workspace is the calendar of record. A FaceTime-style web app
(`frontend/`) lets users call their agent directly.

## layout

- `messaging/` — messaging service (iMessage/SMS in and out)
- `agent/` — the scheduling brain; answers texts via Ambiguous
- `calendar-agent/` — Ambiguous Assistant chat smoke script
- `frontend/` — the call-your-agent web app
- `shared/` — zero-dep helpers shared across services
- `models/` — JSON schemas for every wire shape
- `docs/` — all documentation
- `bus/`, `user-interface/` — reserved, empty (`frontend/` is the real UI)

## docs

- `docs/GOAL.md` — product framing, MVP scope, demo script
- `docs/architecture.txt` — the services and how they connect
- `docs/INTERFACES.md` — component ownership and env vars
- `docs/API.md` — agent endpoints, tools, data model
- `docs/agent.md` — running the agent service
- `docs/messaging.md` — running the messaging service
- `docs/messaging-plan.md` — the messaging-side work plan
- `docs/PHONE.md` / `docs/CALENDAR.md` — wire contracts
- `docs/frontend.md` — the call-your-agent web app
- `docs/ambiguous-integration.md` — verified Ambiguous endpoints
- `docs/calendar-agent.md` / `docs/setup.md` — assistant script + setup

## quick start

```bash
cd frontend && npm install && npm run dev   # see docs/frontend.md
node messaging/index.js                     # see docs/messaging.md
node agent/index.js                         # see docs/agent.md
```
