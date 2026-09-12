import seed from "../data/seed.json";

const STORAGE_KEY = "etai.board.v4";

const ACTIONS = {
  depart: "en_route",
  resolve: "done",
  cancel: "canceled",
};

const RESOLVED = new Set(["done", "canceled"]);

function shiftDay(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function seedBoard() {
  const board = structuredClone(seed);
  const starts = board.jobs
    .filter((j) => !RESOLVED.has(j.status))
    .map((j) => new Date(j.window.start).getTime());
  const anchor = new Date(Math.min(...starts));
  const today = new Date();
  const days = Math.round(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())) /
      86400000
  );
  if (!days) return board;
  for (const job of board.jobs) {
    job.window.start = shiftDay(job.window.start, days);
    job.window.end = shiftDay(job.window.end, days);
    if (job.eta) job.eta = shiftDay(job.eta, days);
  }
  return board;
}

export function loadBoard() {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (!raw) return seedBoard();
  try {
    return JSON.parse(raw);
  } catch {
    return seedBoard();
  }
}

export function saveBoard(board) {
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(board));
}

export function transition(board, jobId, action) {
  const status = ACTIONS[action];
  if (!status || !board.jobs.some((job) => job.id === jobId)) return board;
  return {
    ...board,
    jobs: board.jobs.map((job) => {
      if (job.id === jobId) return { ...job, status };
      if (status === "en_route" && job.status === "en_route")
        return { ...job, status: "confirmed" };
      return job;
    }),
  };
}

const digits = (p) => (p ?? "").replace(/\D/g, "");

const CLIENT_RE = /client:\s*(.*?)\s*(\+?[\d][\d ().-]{5,}\d)\s*$/im;
const TITLE_PHONE_RE = /\+\d[\d ().-]{5,}\d/;
const MEETING_RE = /meeting with\s+(.+?)\s*$/i;

function clientFromEvent(ev, contacts) {
  const m = CLIENT_RE.exec(ev.description ?? "");
  const rawPhone =
    m?.[2] ?? TITLE_PHONE_RE.exec(ev.title ?? "")?.[0] ?? null;
  const phone = rawPhone ? rawPhone.replace(/[^\d+]/g, "") : null;
  const contact = contacts.find(
    (c) => digits(c.phone) && digits(c.phone) === digits(phone)
  );
  const name =
    (m?.[1] && m[1].toLowerCase() !== "unknown" ? m[1].trim() : null) ??
    contact?.name ??
    MEETING_RE.exec(ev.title ?? "")?.[1] ??
    phone ??
    ev.title ??
    "Client";
  return { name, phone, crmId: contact?.id ?? null };
}

function jobDescription(ev) {
  const first = (ev.description ?? "").split("\n")[0].trim();
  return first || ev.title || "Job";
}

/**
 * Merge Ambiguous calendar events into the board. Each event becomes a
 * job plus a customer pulled from the event's Client line, matching CRM
 * contact, or title. Local status wins for events already tracked, so
 * en_route/done flips survive a resync; tracked jobs whose event left
 * the calendar drop off, and local-only jobs (no ambiguousEventId) are
 * untouched.
 */
export function mergeCalendarJobs(board, events, contacts = [], now = new Date()) {
  const seen = new Set(events.map((e) => e.id));
  const customers = [...board.customers];
  const jobs = board.jobs.filter(
    (j) => !j.ambiguousEventId || seen.has(j.ambiguousEventId)
  );
  for (const ev of events) {
    const { name, phone, crmId } = clientFromEvent(ev, contacts);
    const match =
      (phone &&
        customers.find(
          (c) => digits(c.phone) && digits(c.phone) === digits(phone)
        )) ||
      customers.find((c) => c.name === name);
    const customerId =
      match?.id ??
      `cust_cal_${(phone ?? name).replace(/[^\w+]/g, "_").toLowerCase()}`;
    if (!match) {
      customers.push({
        id: customerId,
        name,
        phone,
        address: ev.location ?? "",
        ambiguousCrmId: crmId,
      });
    }
    const existing = jobs.find((j) => j.ambiguousEventId === ev.id);
    const job = {
      id: existing?.id ?? `job_cal_${ev.id}`,
      customerId,
      contractorId: board.contractor.id,
      ambiguousEventId: ev.id,
      status:
        existing?.status ??
        (ev.status === "cancelled"
          ? "canceled"
          : new Date(ev.end_at) <= now
            ? "done"
            : "confirmed"),
      window: { start: ev.start_at, end: ev.end_at },
      address: ev.location ?? "",
      description: jobDescription(ev),
      source: existing?.source ?? "call",
    };
    if (existing?.eta) job.eta = existing.eta;
    if (existing) jobs[jobs.indexOf(existing)] = job;
    else jobs.push(job);
  }
  return { ...board, customers, jobs };
}
