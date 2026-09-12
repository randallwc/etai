const { randomUUID } = require("node:crypto");
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const DEFAULT_FILE = join(__dirname, ".state.json");
const SEEN_CAP = 5000;
const ACTION_CAP = 500;

function empty() {
  return { customers: {}, jobs: {}, pending: {}, actions: [], seen: [] };
}

let file = DEFAULT_FILE;
let state = empty();
if (existsSync(file)) {
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    state = empty();
  }
}

function useFile(path) {
  file = path || null;
  state = empty();
  if (file && existsSync(file)) {
    try {
      state = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      state = empty();
    }
  }
}

function persist() {
  if (file) writeFileSync(file, JSON.stringify(state));
}

function dedup(externalId) {
  if (state.seen.includes(externalId)) return false;
  state.seen.push(externalId);
  if (state.seen.length > SEEN_CAP) state.seen.shift();
  persist();
  return true;
}

function customerByPhone(phone) {
  if (!state.customers[phone]) {
    state.customers[phone] = {
      id: randomUUID(),
      phone,
      name: null,
      address: null,
    };
    persist();
  }
  return state.customers[phone];
}

function addJob(job) {
  const id = job.id ?? randomUUID();
  state.jobs[id] = { ...job, id };
  persist();
  return state.jobs[id];
}

function jobByEventId(ambiguousEventId) {
  return Object.values(state.jobs).find(
    (j) => j.ambiguousEventId === ambiguousEventId,
  );
}

function customerById(id) {
  return Object.values(state.customers).find((c) => c.id === id);
}

function pending(threadKey) {
  return state.pending[threadKey];
}

function setPending(threadKey, value) {
  state.pending[threadKey] = value;
  persist();
}

function clearPending(threadKey) {
  delete state.pending[threadKey];
  persist();
}

function logAction(tool, args, result, error) {
  state.actions.push({
    id: randomUUID(),
    tool,
    args,
    ...(error ? { error: String(error) } : { result }),
    createdAt: new Date().toISOString(),
  });
  if (state.actions.length > ACTION_CAP) state.actions.shift();
  persist();
}

function _reset() {
  state = empty();
  persist();
}

module.exports = {
  dedup,
  customerByPhone,
  customerById,
  addJob,
  jobByEventId,
  pending,
  setPending,
  clearPending,
  logAction,
  useFile,
  _reset,
};
