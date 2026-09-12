# ETAi architecture

ETAi lets clients schedule, reschedule, and cancel contractor appointments by message. Contractors can also use the video call UI. The agent service is the one scheduling brain on the live text path: it interprets a request, keeps booking state, and uses Ambiguous as the calendar and CRM system of record.

```mermaid
flowchart LR
    Client[Client or contractor] -->|text or iMessage| Provider[Phone transport or provider]
    Provider -->|webhook| Msg

    subgraph Messaging[Messaging service: messaging/]
        Msg[Provider webhook or mail poller]
        Normalize[Normalize message]
        Dedup[Deduplicate externalId]
        Fanout[Fan out normalized message]
        Send[POST /send]
        Transport[BlueBubbles, Ambiguous Mail, or stdout simulator]
        Msg --> Normalize --> Dedup --> Fanout
        Send --> Transport
    end

    subgraph Agent[Scheduling agent: agent/]
        Inbound[POST /webhooks/inbound]
        AgentDedup[Deduplicate externalId]
        Intent[Classify intent]
        State[(Thread, customer, and job state)]
        Calendar[Calendar adapter]
        Reply[Compose reply or notification]
        Inbound --> AgentDedup --> Intent
        Intent --> State
        Intent --> Calendar
        State --> Reply
        Calendar --> Reply
    end

    subgraph Ambiguous[Ambiguous workspace]
        AI[Assistant chat\nintent classification]
        API[Calendar and CRM REST APIs]
        Workspace[(Ambiguous workspace\nevents · CRM · tasks · documents)]
        AI --> Workspace
        API --> Workspace
    end

    Fanout -->|normalized inbound message| Inbound
    Intent <-->|intent prompt and JSON result| AI
    Calendar -->|availability and event changes| API
    Reply -->|POST /send| Send
    Transport -->|outbound message| Client

    subgraph Bus[Optional notification bridge: bus/]
        CalendarNotice[POST /webhooks/calendar]
        ContractorNotice[Contractor notification]
        CalendarNotice --> ContractorNotice
    end
    CalendarAgent[calendar-agent/\nsmoke script and notifier] --> CalendarNotice
    ContractorNotice -->|POST /send| Send

    subgraph UI[Video calling platform: frontend/]
        Call[FaceTime-style call UI]
        Direct[Ambiguous REST API]
        Call --> Direct
    end

    User[Video-call user] --> Call
    Direct -->|today: events, tasks, transcript| Workspace
    Call -. planned: prose request .-> Inbound
```

## Sequence: new client schedules a quote

```mermaid
sequenceDiagram
    actor Client as New client
    participant Transport as Phone transport
    participant Messaging as Messaging service
    participant Agent as Scheduling agent
    participant Assistant as Ambiguous Assistant
    participant Workspace as Ambiguous calendar and CRM
    actor Contractor

    Client->>Transport: "I need a plumbing quote tomorrow morning"
    Transport->>Messaging: Provider webhook or mailbox delivery
    Messaging->>Messaging: Normalize and deduplicate externalId
    Messaging->>Agent: POST /webhooks/inbound (normalized message)
    Agent-->>Messaging: 202 Accepted
    Agent->>Agent: Create customer and thread state
    Agent->>Assistant: Classify booking intent
    Assistant-->>Agent: book, tomorrow, morning, quote details
    Agent->>Workspace: Look up contractor availability
    Workspace-->>Agent: Busy slots
    Agent->>Agent: Hold up to three available quote slots in thread state
    Agent->>Messaging: POST /send with numbered slot options
    Messaging->>Transport: Send text
    Transport->>Client: "1) 9:00 AM  2) 10:30 AM ..."

    Client->>Transport: "1"
    Transport->>Messaging: Inbound reply
    Messaging->>Agent: POST /webhooks/inbound (same thread)
    Agent-->>Messaging: 202 Accepted
    Agent->>Agent: Resolve selection against pending proposal
    Agent->>Workspace: Upsert CRM contact if needed
    Agent->>Workspace: Create calendar event for selected quote slot
    Workspace-->>Agent: Event confirmed
    Agent->>Agent: Persist confirmed job and clear proposal
    par Confirm both parties
        Agent->>Messaging: POST /send: booking confirmation to client
        Messaging->>Transport: Send text
        Transport->>Client: Quote appointment confirmed
    and
        Agent->>Messaging: POST /send: new booking notice
        Messaging->>Transport: Send text
        Transport->>Contractor: New quote added to route
    end
```

## Sequence: contractor reports they are running late

```mermaid
sequenceDiagram
    actor Contractor
    participant Transport as Phone transport
    participant Messaging as Messaging service
    participant Agent as Scheduling agent
    participant Assistant as Ambiguous Assistant
    participant State as Agent job state
    participant Workspace as Ambiguous calendar
    actor Client as Affected client

    Contractor->>Transport: "Running 20 minutes late"
    Transport->>Messaging: Provider webhook or mailbox delivery
    Messaging->>Messaging: Normalize and deduplicate externalId
    Messaging->>Agent: POST /webhooks/inbound (normalized message)
    Agent-->>Messaging: 202 Accepted
    Agent->>Assistant: Classify running_late and delayMinutes
    Assistant-->>Agent: running_late, 20 minutes
    Agent->>State: Find the current or next confirmed job
    State-->>Agent: Job, client, and existing event time
    Agent->>Workspace: PATCH event start and end +20 minutes
    Workspace-->>Agent: Updated event
    Agent->>State: Save shifted window and new ETA
    Agent->>Messaging: POST /send: new ETA to affected client
    Messaging->>Transport: Send text
    Transport->>Client: "Running about 20 min late — new ETA ..."
    Agent->>Messaging: POST /send: update confirmation
    Messaging->>Transport: Send text
    Transport->>Contractor: "Updated — shifted the job and let them know."
```

## Components

### Messaging service

`messaging/` owns inbound and outbound channels, but no scheduling logic. An inbound provider webhook or mailbox delivery is normalized into `channel`, `from`, `body`, `externalId`, `receivedAt`, and `threadKey`; it is deduplicated by `externalId` and delivered to subscribers. The live subscription target is the agent's `POST /webhooks/inbound` endpoint.

Callers send replies through `POST /send` with `to`, `body`, and `threadKey`. The service selects BlueBubbles when configured, otherwise its stdout simulator. See `docs/PHONE.md` and `docs/messaging.md`.

### Scheduling agent

`agent/` receives normalized messages through `POST /webhooks/inbound`, deduplicates them again, and processes them asynchronously. It owns per-thread pending proposals, customer and job records, intent classification, calendar actions, and message replies. Client-originated changes also notify the contractor; contractor-originated changes notify the affected client.

### Ambiguous workspace and calendar adapter

`agent/calendar.js` exposes availability, day listing, create, update, and cancel operations to the scheduling loop. It calls Ambiguous through `agent/ambiguous.js`, the only backend file that fetches Ambiguous. Without an API key, the adapter uses an in-memory calendar so the same workflow can run offline.

The Ambiguous workspace is the system of record for events, CRM, tasks, and documents. Its Assistant returns a structured intent for each message; the agent loop—not the Assistant—then selects available slots and makes calendar changes. `calendar-agent/` remains a smoke-script and calendar-notification integration.

### Optional notification bridge

`bus/` is not subscribed to live inbound messages; subscribing both `bus/` and `agent/` would produce duplicate answers. It may receive calendar notifications at `POST /webhooks/calendar` from `calendar-agent/notify.js` and text the contractor through the messaging service.

### Video calling UI

`frontend/` currently calls the Ambiguous REST API directly from the browser. It makes scheduling requests into calendar events, turns other requests into tasks, and stores finished-call transcripts as workspace documents. The intended path routes video prose through the agent so all requests share one scheduling workflow.

## Data paths

The live message path is client or contractor → phone transport → messaging → agent → Ambiguous. Replies travel agent → messaging → selected transport → client or contractor. Messaging and the agent both deduplicate inbound messages by `externalId`.

The UI path is currently video call UI → Ambiguous REST API → workspace. The dashed edge in the diagram is planned only: video call UI → agent → Ambiguous.

## Ownership and operational notes

Contractors own schedules and travel to job sites. Clients message to book, reschedule, or cancel. Contractors receive daily summaries in their chosen channel; clients receive arrival, delay, cancellation, and reschedule notifications.

Message deduplication is best-effort: the messaging service keeps `externalId` values in memory, so a restart can accept a duplicate once. The agent also deduplicates receipt before it starts its asynchronous loop.

The Assistant chat endpoint needs verification against the active workspace before new work relies on it. Some docs and `calendar-agent/test.js` use `POST /api/assistant/chat`, while the live OpenAPI catalog previously did not list that path. The workspace specification is authoritative.

## Design decisions

The bus must not parse scheduling intent. That would create a second scheduling agent that can disagree with the live agent loop. The scheduling agent owns meaning, slot proposals, and calendar decisions.

A direct messaging-to-calendar connection was rejected because stateful booking proposals, notifications, and future enrichment need one owner. Browser-side MCP and the Ambiguous CLI were also rejected for the UI: MCP is a tool-calling transport unsuitable for a browser-held key, and the CLI shells out for each call; plain REST is used instead.

## Related documents

See `docs/INTERFACES.md` for component ownership and environment variables, `docs/API.md` for bus endpoints and tools, `docs/CALENDAR.md` for the calendar contract, `docs/PHONE.md` for the messaging contract, `docs/GOAL.md` for product framing, and `README.md` for MVP scope.
