CopilotKit -- sms and imessage agent migration
==============================================

Owner: agent core (bus/). This file records what CopilotKit v2 actually is,
which pieces we use, the credentials situation, and the approaches that were
considered and rejected. Source: docs.copilotkit.ai/cookbook and
docs.copilotkit.ai/reference, read 2026-09-12.

WHAT THE COOKBOOK IS
--------------------

The cookbook is a set of focused recipes for wiring CopilotKit to external
tools: Daytona sandboxed code execution, Claude Managed Agents over AG-UI,
Oracle Agent Spec memory, Arcade OAuth tools, Angular + Google ADK, and
OpenBox governance. None of them ship an SMS or iMessage adapter. CopilotKit
is the agent layer, not the phone pipe -- our messaging/ service stays the
transport and CopilotKit becomes the brain that answers the texts.

THE PIECES THAT MATTER
----------------------

@copilotkit/runtime, v2 subpath. Version pinned at 1.70.1 (published
2026-09-03; the 7-day rule ruled out 1.71.x). Ships both ESM (.mjs) and CJS
(.cjs) builds, so require("@copilotkit/runtime/v2") works inside our
CommonJS bus.

  CopilotRuntime      serves named agents over AG-UI
  createCopilotRuntimeHandler / framework handlers under /v2/express,
                      /v2/hono, /v2/node -- mount on a server when a UI
                      needs the endpoint; not needed to run agents
                      in-process
  BuiltInAgent        the primary agent class. Classic mode:
                      new BuiltInAgent({ model, tools, maxSteps, prompt }).
                      Model strings are "provider/model" (openai/gpt-4.1,
                      anthropic/claude-sonnet-4.5, google/gemini-2.5-flash);
                      apiKey option falls back to OPENAI_API_KEY /
                      ANTHROPIC_API_KEY / GOOGLE_API_KEY. Powered by Vercel
                      AI SDK; tools run server-side inside the run loop.
  Factory mode        BuiltInAgent({ type: "custom", factory }) -- the
                      factory returns an AsyncIterable of AG-UI events and
                      owns the LLM call itself. This is how we run without
                      an OpenAI/Anthropic/Google key: the factory drives
                      Ambiguous assistant/chat and translates its JSON
                      replies into AG-UI events.
  CopilotKitIntelligence  optional runtime plugin; apiKey is the cpk-
                      project key. Gives durable threads, the inspector,
                      learning containers. Server-side only.
  InMemoryAgentRunner default runner; per-thread state lives in the
                      runner, not the agent.

AG-UI is the wire protocol: a run is POST {threadId, runId, messages, tools}
against /api/copilotkit/agent/{name}/run and answers an SSE stream of
TEXT_MESSAGE_* / TOOL_CALL_* / RUN_* events. State is run-scoped, not
broadcast -- a UI board would need each inbound text to trigger a run, which
is exactly the flow sms/imessage already uses.

@copilotkit/core is the headless client (CopilotKitCore: runtimeUrl,
addTool for client-executed "frontend" tools, runAgent). It would let the
bus drive a remote runtime. We run the runtime in-process instead; noted so
nobody adds the client package without a second runtime to talk to.

Gotchas from the docs worth repeating:

  - One BuiltInAgent instance refuses a second concurrent run ("Agent is
    already running"). Per-thread agent instances or serialized runs are
    required; we keep one agent per threadKey.
  - v1 vs v2: most tutorials still show the deprecated v1 API. Use /v2
    subpath imports everywhere.
  - The endpoint an external agent takes is its own server, not
    /api/copilotkit -- irrelevant for BuiltInAgent (in-process) but it
    bites people wiring HttpAgent.

CREDENTIALS
-----------

  COPILOT_API=cpk-...   already in repo-root .env. This is a CopilotKit
                        Intelligence project key (the docs call it
                        CPK_INTELLIGENCE_API_KEY). It authenticates
                        threads/inspector/learning -- it is NOT an LLM key.
  LLM key             BuiltInAgent classic mode needs one of OPENAI_API_KEY,
                        ANTHROPIC_API_KEY, GOOGLE_API_KEY. None exists in
                        .env as of 2026-09-12. The iMessage inbox was
                        searched (all message text + every attachment from
                        the hackathon window); the creds mentioned are the
                        cpk key already captured, no LLM key was found.
                        Until one lands, factory mode backs the agent with
                        Ambiguous assistant/chat (AMBIG_API), the same LLM
                        bus/ai.js already uses.

WHY THIS SHAPE
--------------

The ask was "move all sms and imessage to CopilotKit." What moves is the
answering brain: channels sms and imessage stop going through the
hand-rolled intent switch in bus/loop.js and instead become runs of a
CopilotKit BuiltInAgent whose tools wrap the existing calendar, store, and
notify boundaries. What does not move: messaging/ (still the transport, the
PHONE.md contract is unchanged), Ambiguous (still the system of record),
loop.js (still owns console channel and is the fallback when the agent is
not configured).

The tools mirror models/copilot-agent.schema.json: get_schedule,
get_availability, book_job, reschedule_job, cancel_job, report_delay,
send_text, create_task. The agent keeps conversation state per threadKey,
so a slot proposal survives across texts without the pendingProposal
state machine.

TRIED AND REJECTED
------------------

CopilotKit Channels SDK (@copilotkit/channels) for sms/imessage: it only
ships managed Slack and Teams agents. No SMS/iMessage adapter exists; this
was already recorded as rejected in docs/INTEGRATIONS.md and stays
rejected.

CopilotKit Cloud hosted agent endpoint: does not exist. The runtime is
self-hosted; Intelligence is persistence/observability, not a managed
agent. There is nothing to POST sms traffic at in their cloud, so the
runtime runs inside the bus.

Hand-rolled AG-UI client against the runtime over loopback HTTP: possible
but ceremonial. BuiltInAgent runs in-process; the runner keeps thread
state. If a board UI lands later, mount createCopilotRuntimeHandler on the
same process and it serves the same agents -- the in-process path and the
HTTP path share the runner.

Deleting loop.js: rejected for now. It remains the fallback for console
channel and for any environment without the copilot deps installed. When
the CopilotKit path proves itself on real traffic it can retire.
