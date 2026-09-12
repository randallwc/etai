const { partsInTz } = require("./calendar.js");

const INTENTS = ["book", "day_summary", "running_late", "cancel", "reschedule", "eta", "clarify", "other"];

function extractJson(text) {
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(text.slice(i, j + 1));
  } catch {
    return null;
  }
}

function contextLines(ctx) {
  if (!ctx) return [];
  const lines = [];
  if (ctx.role) lines.push(`Texter role: ${ctx.role}.`);
  if (ctx.customer?.name) lines.push(`Texter name: ${ctx.customer.name}.`);
  if (ctx.jobs?.length) {
    lines.push("Their active jobs: " + ctx.jobs.map((j) => `${j.id} "${j.description ?? j.title}" at ${j.window?.start ?? j.startAt}`).join("; "));
  }
  if (ctx.pending) {
    lines.push(
      `A ${ctx.pending.mode} proposal is pending: ${ctx.pending.slots.map((s, i) => `${i + 1}) ${s.start}`).join("  ")}`
    );
  }
  if (ctx.history?.length) {
    lines.push("Recent thread:", ...ctx.history.map((h) => `${h.role}: ${h.body}`));
  }
  return lines.length ? ["Context:", ...lines] : [];
}

function prompt(text, todayLabel, ctx) {
  return [
    "You are the intent extractor for a contractor's scheduling assistant that works over SMS.",
    "Return ONLY raw JSON matching this shape, no markdown, no prose:",
    '{"intent":"book|day_summary|running_late|cancel|reschedule|eta|clarify|other","dayRef":"today|tomorrow|<weekday>|<YYYY-MM-DD>","timePref":"morning|afternoon|evening|HH:MM","durationMinutes":0,"delayMinutes":0,"name":"","description":"","jobRef":"","question":"","say":"","slotChoice":0}',
    "Use null for any field that is absent. Rules:",
    '- "running N late", "behind", "stuck in traffic" -> running_late, delayMinutes=N',
    "- asking about today's or a day's schedule -> day_summary",
    "- wants to book, come by, schedule, get a visit -> book",
    "- wants to move an existing booking -> reschedule",
    "- wants to cancel -> cancel",
    '- client asking "where are you", ETA, when arriving, how far out -> eta',
    '- picking an offered option ("the first one", "2", "2pm works") -> book with slotChoice set',
    '- references an existing job ("the sprinkler one", "my 2pm") -> set jobRef to its id, title fragment, or time',
    "- compound requests (cancel AND rebook) or not enough info to act -> clarify with a short question",
    "- for clarify and other, draft the reply in say (one or two SMS sentences; never promise an action the intent does not perform)",
    "- anything else -> other",
    ...contextLines(ctx),
    `Today is ${todayLabel}.`,
    `Text: ${JSON.stringify(text)}`,
  ].join("\n");
}

/**
 * Keyword fallback for when the Assistant is unreachable or unconfigured
 * (no AMBIG_API). Covers the demo-critical intents; everything else is
 * "other" and hits the loop's help text.
 */
function fallbackClassify(text) {
  const s = text.toLowerCase();
  const late = s.match(/running\s+(\d+)?\s*(min(?:ute)?s?\s+)?late|behind|stuck in traffic/);
  if (late) {
    const mins = s.match(/(\d+)\s*(?:min|late)/)?.[1];
    return { intent: "running_late", delayMinutes: mins ? +mins : null };
  }
  if (/my (day|schedule|route)|schedule today|tomorrow'?s schedule/.test(s)) return { intent: "day_summary" };
  if (/cancel/.test(s)) return { intent: "cancel" };
  if (/resched|move|push back|different time/.test(s)) return { intent: "reschedule" };
  if (/where are you|\beta\b|when.*(here|arrive|coming)|how (far|long)|arriving/.test(s)) return { intent: "eta" };
  if (/need|book|schedul|appointment|come (by|over|fix)|fix|available|can you/.test(s)) {
    return { intent: "book", description: text };
  }
  return { intent: "other" };
}

function normalize(raw) {
  if (!raw || !INTENTS.includes(raw.intent)) return { intent: "other" };
  return {
    intent: raw.intent,
    dayRef: typeof raw.dayRef === "string" && raw.dayRef ? raw.dayRef : null,
    timePref: typeof raw.timePref === "string" && raw.timePref ? raw.timePref : null,
    durationMinutes: Number.isInteger(raw.durationMinutes) && raw.durationMinutes > 0 ? raw.durationMinutes : null,
    delayMinutes: Number.isInteger(raw.delayMinutes) && raw.delayMinutes > 0 ? raw.delayMinutes : null,
    name: typeof raw.name === "string" && raw.name ? raw.name : null,
    description: typeof raw.description === "string" && raw.description ? raw.description : null,
    jobRef: typeof raw.jobRef === "string" && raw.jobRef ? raw.jobRef : null,
    question: typeof raw.question === "string" && raw.question ? raw.question : null,
    say: typeof raw.say === "string" && raw.say ? raw.say : null,
    slotChoice: Number.isInteger(raw.slotChoice) && raw.slotChoice > 0 ? raw.slotChoice : null,
  };
}

/**
 * The agent's AI reader: classify an inbound text into the intent contract
 * (models/intent.schema.json) via Ambiguous assistant/chat. `chat` is a
 * (prompt) => assistant response body function; injectable for tests.
 * Falls back to {intent:"other"} on any failure -- never throws.
 */
const FAST_INTENTS = new Set(["day_summary", "running_late", "eta"]);

function createAi({ chat, env = process.env, now = () => new Date() }) {
  const tz = env.CONTRACTOR_TZ ?? "America/Los_Angeles";
  const classifyTimeoutMs = Number(env.AI_CLASSIFY_TIMEOUT_MS) || 15000;
  async function classify(text, ctx) {
    const fast = fallbackClassify(text);
    if (FAST_INTENTS.has(fast.intent)) return fast;
    try {
      const p = partsInTz(tz, now());
      const today = `${p.weekday} ${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
      let timer;
      const res = await Promise.race([
        chat(prompt(text, today, ctx)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("classify timeout")), classifyTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      const parsed = extractJson(res?.response ?? "");
      return parsed ? normalize(parsed) : fast;
    } catch {
      return fast;
    }
  }
  return { classify, extractJson, fallbackClassify };
}

module.exports = { createAi, extractJson };
