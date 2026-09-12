import seed from "../data/seed.json";

const STORAGE_KEY = "etai.board";

const ACTIONS = {
  depart: "en_route",
  resolve: "done",
  cancel: "canceled",
};

export function seedBoard() {
  return structuredClone(seed);
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
    jobs: board.jobs.map((job) =>
      job.id === jobId ? { ...job, status } : job
    ),
  };
}
