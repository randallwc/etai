const DONE_RE =
  /^(yes|yeah|yep|yup|that's all|thats all|that is all|all set|done|no|nope|nothing else|i'm good|im good|perfect|great|bye)[.!]?$/i;

const SCHEDULE_RE =
  /meet|schedul|book|call|lunch|dinner|appointment|sync|coffee/i;

export function isDoneSignal(text) {
  return DONE_RE.test(text.trim());
}

export function parseRequest(text) {
  if (!SCHEDULE_RE.test(text)) return { kind: "task" };
  const withName = text.match(/with\s+([A-Za-z]+)/)?.[1] ?? null;
  const t = text.toLowerCase();
  const dayOffset = /day after tomorrow/.test(t)
    ? 2
    : /tomorrow/.test(t)
      ? 1
      : /next week/.test(t)
        ? 7
        : 0;
  let hour = /afternoon/.test(t)
    ? 14
    : /evening/.test(t)
      ? 18
      : /noon|lunch/.test(t)
        ? 12
        : 10;
  const at = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (at) hour = (parseInt(at[1], 10) % 12) + (at[3] === "pm" ? 12 : 0);
  return { kind: "schedule", withName, dayOffset, hour };
}

export function offlineReply(text) {
  const req = parseRequest(text);
  if (req.kind === "schedule") {
    const day = req.dayOffset === 0 ? "today" : req.dayOffset === 1 ? "tomorrow" : `in ${req.dayOffset} days`;
    const h12 = ((req.hour + 11) % 12) + 1;
    return `Will do — checking Ambiguous. Done: meeting is scheduled${
      req.withName ? ` with ${req.withName}` : ""
    } for ${h12}${req.hour >= 12 ? "pm" : "am"} ${day}, based on availability. Is that all?`;
  }
  return "Got it — I've logged that in Ambiguous as a task. Is that all?";
}
