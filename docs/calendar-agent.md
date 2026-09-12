The calendar-agent folder holds the Ambiguous calendar integration. main.js
is a minimal MCP client: it posts JSON-RPC to the workspace MCP server at
https://app.ambiguous.ai/mcp (Streamable HTTP transport, protocol version
2025-06-18, Bearer auth), then calls the list_calendars and list_events tools
directly and formats the week summary locally.

Set AMBIGUOUS_API_KEY to a workspace API key in the repo-root .env (loaded via
process.loadEnvFile; real environment variables take precedence) and run
npm run test:calendar. AMBIGUOUS_BASE_URL defaults to https://app.ambiguous.ai.
AMBIGUOUS_DAYS sets the lookahead window and defaults to 7.

Why MCP and not the Assistant endpoint: POST /api/assistant/chat runs the
whole agentic loop inside one HTTP request. Each tool round-trip costs an LLM
call, so a "list calendars and summarize the week" prompt exceeds the ~30s
upstream gateway timeout and returns 504. The same ceiling applies to the
assistant_chat MCP tool -- the gateway cuts the stream at 30s regardless of
transport. Calling the underlying tools directly keeps each request around a
second and moves the summarization client-side, which is deterministic anyway.

Gotchas. The server is stateless: no mcp-session-id header is issued, so each
tools/call POST is self-contained and calls can be parallelized. The
notifications/initialized notification is not implemented server-side and is
skipped. Tool results arrive twice: content text blocks carrying pretty JSON
and structuredContent carrying the same payload; we read structuredContent
and fall back to parsing the text. Assistant_chat accepts {message, context,
history} and is reachable over MCP if a free-form turn is ever needed, but
expect 504s on anything that needs more than one tool call.

The wire shapes live in models/mcp-contract.schema.json.
