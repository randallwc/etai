The calendar-agent folder holds the Ambiguous Assistant integration. The script sends a natural-language task to Ambiguous Assistant instead of invoking calendar endpoints directly. The Assistant decides which calendar tools to call and returns written output plus the tool-call trace.

Set AMBIGUOUS_API_KEY to a workspace API key and run npm run test:calendar. The key is read from the process environment and is never stored in this repository. AMBIGUOUS_BASE_URL is optional and defaults to https://app.ambiguous.ai.

The default task is read-only. It asks for calendars and the next seven days of events while explicitly prohibiting creates, updates, cancellations, declines, and deletions. AMBIGUOUS_TASK overrides this only for deliberate tests; an override can cause the Assistant to perform the requested actions.

The response boundary is represented by models/assistant-chat-response.schema.json. The schema permits additive response fields while requiring the Assistant response text, tool-call trace, SPEAR result, and status.
