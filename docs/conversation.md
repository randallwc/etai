Conversation spec -- context-aware AI reader
=============================================

Extends docs/bus.md. Today ai.js classifies each text in isolation.
This spec makes the reader conversational: it sees the thread, the
pending proposal, and the texter's jobs, and it may ask a question
instead of guessing. One assistant/chat call per inbound text stays --
no new moving parts.

CONTEXT BLOCK
-------------

classify(text) becomes classify(text, ctx). loop.js builds ctx before
the call, and ai.js renders it into the prompt:

  ctx.today        -- weekday + date in CONTRACTOR_TZ (already sent)
  ctx.role         -- "contractor" | "client" (msg.from vs CONTRACT_PHONE)
  ctx.customer     -- stored customer for msg.from (name if known)
  ctx.jobs         -- active jobs for this phone: [{id, title, startAt}]
                      resolved from state.jobs via jobForPhone; at most 5
  ctx.pending      -- pendingProposal if any: mode, slot times
  ctx.history      -- last 8 thread messages, role-tagged
                      "client: ..." / "etai: ..."

History lives in state.js threads[threadKey].history -- append {role,
body, at} after each inbound and each outbound say(), cap at 8 (older
dropped). Persisted with the rest of the state file.

NEW INTENT FIELDS (models/intent.schema.json, updated)
------------------------------------------------------

  clarify  -- new intent. When the model cannot pick one intent with
             confidence, or the request is compound ("cancel tomorrow
             and rebook friday"), it returns clarify plus question.
             loop texts question, stores threads[k].pendingClarify, and
             the next inbound text is classified with the question in
             history so "the first one" resolves correctly.

  jobRef   -- resolves which job a client means: "the sprinkler one",
             "my 2pm", "the second job". loop matches jobRef against
             ctx.jobs by id, title substring, or start time. If no
             match -> clarify. Needed once a client has >1 active job;
             today jobForPhone returns the single active job and any
             ambiguity is a silent wrong-job bug.

  say      -- model-drafted reply for clarify and other. One or two
             SMS sentences. loop uses it verbatim instead of the static
             help fallback, keeping the voice consistent.

  eta      -- was already handled by loop but missing from the enum;
             now in the schema.

RULES FOR THE MODEL (prompt additions)
--------------------------------------

  - Use jobRef whenever the text references an existing job and the
    texter has more than one.
  - Never invent a date: no dayRef + no resolvable history -> clarify
    "which day works?"
  - Compound requests -> clarify, one action per text. State the two
    steps in the question so the reply disambiguates.
  - say must not promise an action the intent does not perform.

LOOP CHANGES
------------

  - buildCtx(msg): gathers history, jobs, pending, role; passes to
    classify.
  - pendingClarify: stored like pendingProposal. A reply that matches
    a slotChoice is still consumed by pendingProposal first; otherwise
    classify sees the clarify question in history.
  - jobForPhone resolves via jobRef when provided, else current
    single-job behavior.
  - clarify: text question to the texter; log action "clarify".
  - other: text intent.say if present, else the existing help text.

REJECTED ALTERNATIVES
---------------------

  - Ambiguous server-side conversations (POST /api/conversations +
    message ids) to hold thread state. Rejected: our thread state
    must be inspectable and testable offline; server-side memory
    duplicates state.js and adds a second source of truth.

  - Letting assistant/chat call calendar tools directly (the bus/
    pattern). Rejected for the agent path: we lose control of which
    writes happen and cannot gate them behind slot picks. bus stays
    for freeform Q&A only, off the subscriber list.

  - Multiple intents per message. Rejected: KISS -- one action, one
    confirmation. Compound gets a clarify.

TESTS
-----

  - classify with history resolves "the earlier one" via jobRef.
  - clarify round-trip: vague text -> question stored -> answer books.
  - compound request returns clarify with a two-step question.
  - history capped at 8 and survives a state reload.
  - jobRef matches by title fragment and by time; miss -> clarify.
