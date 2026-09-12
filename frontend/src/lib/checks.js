const WORK_START = 8;
const WORK_END = 17;
const MAX_TRAVEL_MIN = 45;
const RAIN_THRESHOLD = 50;

/**
 * Run the pre-booking checklist for a candidate slot. Only checks whose
 * inputs were actually fetched are included — missing data is skipped, not
 * failed. Returns SchedulingCheck[] (see models/scheduling-check.schema.json).
 */
export function runChecks({
  slot,
  prevEnd = null,
  travelMinutes = null,
  precipProb = null,
}) {
  const endHour = slot.end.getHours() + slot.end.getMinutes() / 60;
  const checks = [
    {
      name: "hours",
      ok: slot.start.getHours() >= WORK_START && endHour <= WORK_END,
      detail: "within working hours",
      warn: `outside working hours (${WORK_START}am–${WORK_END - 12}pm)`,
    },
  ];
  if (travelMinutes != null) {
    const gapMin = prevEnd ? (slot.start - prevEnd) / 60000 : Infinity;
    checks.push({
      name: "travel",
      ok: travelMinutes <= MAX_TRAVEL_MIN && gapMin >= travelMinutes,
      detail: `${travelMinutes} min drive${prevEnd ? " from the last job" : ""}`,
      warn:
        gapMin < travelMinutes
          ? `tight travel — only ${Math.round(gapMin)} min between jobs`
          : `long drive (${travelMinutes} min)`,
    });
  }
  if (precipProb != null) {
    checks.push({
      name: "weather",
      ok: precipProb < RAIN_THRESHOLD,
      detail: `${precipProb}% chance of rain`,
      warn: `rain likely (${precipProb}%)`,
    });
  }
  return checks;
}

/** Spoken summary: pass details for ok checks, warnings for failures. */
export function summarizeChecks(checks) {
  const good = checks.filter((c) => c.ok).map((c) => c.detail);
  const bad = checks.filter((c) => !c.ok).map((c) => c.warn || c.detail);
  const parts = [];
  if (good.length) parts.push(good.join(", "));
  if (bad.length) parts.push(`heads up: ${bad.join(", ")}`);
  return parts.length ? parts.join(". ") + "." : "";
}
