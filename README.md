<img src="docs/logo/etai-wordmark.svg" alt="etAI" width="220">

**etAI: AI dispatcher for the trades.**

A dispatcher you text or call. Contractors and clients book,
reschedule, and cancel appointments over SMS and calls; an
Ambiguous.ai workspace is the calendar of record. A FaceTime-style
web app (`frontend/`) lets users call their agent directly.

The path is short: a text or call turn comes into the one service
(`messaging/`), the scheduling loop classifies intent and touches the
calendar, and the reply goes back out the same transport.

<img src="docs/screenshots/sms-booking.jpeg" alt="Booking a job over SMS" width="320">
<img src="docs/screenshots/call-screen.png" alt="Call-your-agent screen" width="640">

## layout

- `messaging/`: the whole backend - transports, scheduling loop,
  calendar adapter, state, Ambiguous boundary
- `frontend/`: the call-your-agent web app
- `docs/`: all documentation

## docs

- [The service](docs/messaging.md): modules, endpoints, intents,
  transports, and gotchas.
- [Frontend](docs/frontend.md): the call-your-agent web app.
- [Ambiguous](docs/ambiguous.md): the workspace integration - verified
  endpoints, setup, gotchas.
- [Notes](docs/notes.md): unpinned behaviors and cut features.

## quick start

```bash
npm start                                      # the service on :4020
npm --prefix frontend install && npm run dev   # the web app
```

`npm test` runs the backend smoke suite. `npm --prefix frontend test`
and `npm run build` verify the web app.
