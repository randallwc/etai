const { join } = require("node:path");
require(join(__dirname, "..", "shared", "env.js")).loadEnv();

const key = process.env.AMBIG_API ?? process.env.AMBIGUOUS_API_KEY;
const base = (process.env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
const TZ = "America/Los_Angeles";

const JOBS = [
  { day: 0, start: "15:00", mins: 60, title: "Sprinkler repair — Rivera", phone: "+14253625633" },
  { day: 0, start: "16:00", mins: 90, title: "Water heater check — Chen", phone: "+14253625633" },
  { day: 0, start: "17:30", mins: 60, title: "Fence gate fix — Okafor", phone: "+14253625633" },
  { day: 1, start: "09:30", mins: 60, title: "Haul debris — Diaz", phone: "+14253625633" },
  { day: 1, start: "13:00", mins: 90, title: "Irrigation tune-up — Park", phone: "+14253625633" },
];

function dateInTz(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function toUtcIso(date, hhmm) {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const wall = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric",
  }).formatToParts(new Date(guess));
  const g = (t) => +wall.find((p) => p.type === t).value;
  const wallMs = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
  return new Date(guess - (wallMs - guess)).toISOString();
}

async function api(path, method, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "API-Version": "1" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function main() {
  if (!key) throw new Error("AMBIG_API not set");
  const calendars = await api("/calendars", "GET");
  const calendarId = (calendars.data ?? []).find((c) => c.is_default)?.id ?? calendars.data?.[0]?.id;
  if (!calendarId) throw new Error("no calendar found");
  for (const j of JOBS) {
    const date = dateInTz(j.day);
    const start = toUtcIso(date, j.start);
    const end = new Date(new Date(start).getTime() + j.mins * 60000).toISOString();
    const ev = await api(`/calendars/${calendarId}/events`, "POST", {
      title: j.title,
      start_at: start,
      end_at: end,
      description: `seeded demo job\nclient ${j.phone}`,
    });
    console.log(`created ${ev.id ?? ev.event?.id}: ${j.title} ${start}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
