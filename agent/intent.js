const DAY_NAMES = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Deterministic intent router for contractor messages. Returns
 * { type, ...params }. Keep the recognized surface small and obvious --
 * an LLM decider can replace this function later without touching the
 * action layer.
 */
function parseIntent(text) {
  const t = text.trim().toLowerCase();

  const lateMatch =
    t.match(/running\s+(\d+)\s*(?:min(?:ute)?s?)?\s*late/) ||
    t.match(/(\d+)\s*(?:min(?:ute)?s?)\s*late/) ||
    t.match(/late\s+by\s+(\d+)/);
  if (lateMatch || (/running\s+late|behind\s+schedule|running\s+behind/.test(t))) {
    return { type: "late", minutes: lateMatch ? Number(lateMatch[1]) : 15 };
  }

  if (/^(yes|yeah|yep|yup|y|confirm|book it|sounds good|perfect|ok(ay)?)[\s!.]*$/.test(t)) {
    return { type: "confirm" };
  }
  if (/^(no|nope|nah|different|another|not that)[\s!.]*$/.test(t)) {
    return { type: "decline" };
  }

  if (/cancel/.test(t)) {
    return { type: "cancel" };
  }

  if (
    /what'?s?\s+(my\s+)?(day|schedule|agenda)|what do i have|my day|today'?s?\s+(schedule|jobs)|jobs (today|tomorrow)|tomorrow'?s?\s+(schedule|jobs)/.test(t)
  ) {
    return { type: "day" };
  }

  const day = Object.keys(DAY_NAMES).find((d) => t.includes(d));
  const wantsBook =
    /\b(book|come|need|schedule|appointment|visit|repair|fix|install|quote|estimate|available|free|open)\b/.test(t) ||
    day !== undefined ||
    /\btomorrow\b|\btoday\b|morning|afternoon/.test(t);
  if (wantsBook) {
    return {
      type: "book",
      dayName: day,
      relative: /\btomorrow\b/.test(t) ? "tomorrow" : /\btoday\b/.test(t) ? "today" : null,
      partOfDay: /\bafternoon\b/.test(t) ? "afternoon" : /\bmorning\b/.test(t) ? "morning" : null,
      text: t,
    };
  }

  return { type: "unknown" };
}

/**
 * Resolves a parsed day reference to a YYYY-MM-DD in local time.
 */
function resolveDate(intent, now = new Date()) {
  if (intent.relative === "today") return toLocalDate(now);
  if (intent.relative === "tomorrow") {
    return toLocalDate(new Date(now.getTime() + 86400000));
  }
  if (intent.dayName) {
    const target = DAY_NAMES[intent.dayName];
    const d = new Date(now);
    d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7 || 7));
    return toLocalDate(d);
  }
  return toLocalDate(now);
}

function toLocalDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { parseIntent, resolveDate, toLocalDate };
