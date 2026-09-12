import seed from "../data/seed.json";

const STORAGE_KEY = "etai.board.v3";

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
