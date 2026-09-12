const { partsInTz } = require("./calendar.js");

const INTENTS = ["book", "day_summary", "running_late", "cancel", "reschedule", "other"];

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

function prompt(text, todayLabel) {
  return [
    "You are the intent extractor for a contractor's scheduling assistant that works over SMS.",
    "Return ONLY raw JSON matching this shape, no markdown, no prose:",
    '{"intent":"book|day_summary|running_late|cancel|reschedule|other","dayRef":"today|tomorrow|<weekday>|<YYYY-MM-DD>","timePref":"morning|afternoon|evening|HH:MM","durationMinutes":0,"delayMinutes":0,"name":"","description":"","slotChoice":0}',
    "Use null for any field that is absent. Rules:",
    '- "running N late", "behind", "stuck in traffic" -> running_late, delayMinutes=N',
    "- asking about today's or a day's schedule -> day_summary",
    "- wants to book, come by, schedule, get a visit -> book",
    "- wants to move an existing booking -> reschedule",
    "- wants to cancel -> cancel",
    '- picking an offered option ("the first one", "2", "2pm works") -> book with slotChoice set',
    "- anything else -> other",
    `Today is ${todayLabel}.`,
    `Text: ${JSON.stringify(text)}`,
  ].join("\n");
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
    slotChoice: Number.isInteger(raw.slotChoice) && raw.slotChoice > 0 ? raw.slotChoice : null,
  };
}

/**
 * The agent's AI reader: classify an inbound text into the intent contract
 * (models/intent.schema.json) via Ambiguous assistant/chat. `chat` is a
 * (prompt) => assistant response body function; injectable for tests.
 * Falls back to {intent:"other"} on any failure -- never throws.
 */
function createAi({ chat, env = process.env, now = () => new Date() }) {
  const tz = env.CONTRACTOR_TZ ?? "America/Los_Angeles";
  async function classify(text) {
    try {
      const p = partsInTz(tz, now());
      const today = `${p.weekday} ${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
      const res = await chat(prompt(text, today));
      return normalize(extractJson(res?.response ?? ""));
    } catch {
      return { intent: "other" };
    }
  }
  return { classify, extractJson };
}

module.exports = { createAi, extractJson };
