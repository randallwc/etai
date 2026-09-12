const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");

const SEEN_CAP = 5000;

/**
 * Agent state: seen message ids, customers, jobs, threads, action log.
 * Persists to a JSON file on every mutation when `file` is set; pass null
 * for memory-only (tests). Shapes follow models/*.schema.json.
 */
function createStore(file = null) {
  const data = {
    seen: [],
    customers: {},
    jobs: {},
    threads: {},
    actions: [],
    ...(file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}),
  };

  function save() {
    if (file) writeFileSync(file, JSON.stringify(data, null, 1));
  }

  function dedup(externalId) {
    if (data.seen.includes(externalId)) return false;
    if (data.seen.length >= SEEN_CAP) data.seen.shift();
    data.seen.push(externalId);
    save();
    return true;
  }

  function upsertCustomer(phone, fields = {}) {
    const c = data.customers[phone] ?? { id: `cust-${randomUUID().slice(0, 8)}`, phone };
    Object.assign(c, fields);
    data.customers[phone] = c;
    save();
    return c;
  }

  function addJob(fields) {
    const job = { id: `job-${randomUUID().slice(0, 8)}`, ...fields };
    data.jobs[job.id] = job;
    save();
    return job;
  }

  function nextJob(nowMs) {
    return Object.values(data.jobs)
      .filter(
        (j) =>
          (j.status === "confirmed" || j.status === "en_route") &&
          new Date(j.window.end).getTime() > nowMs
      )
      .sort((a, b) => new Date(a.window.start) - new Date(b.window.start))[0] ?? null;
  }

  function jobForPhone(phone) {
    const c = data.customers[phone];
    if (!c) return null;
    return (
      Object.values(data.jobs)
        .filter((j) => j.customerId === c.id && j.status !== "canceled" && j.status !== "done")
        .sort((a, b) => new Date(b.window.start) - new Date(a.window.start))[0] ?? null
    );
  }

  function setThread(threadKey, patch) {
    const t = data.threads[threadKey] ?? { threadKey };
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    data.threads[threadKey] = t;
    save();
    return t;
  }

  function logAction({ tool, args, result, error }) {
    data.actions.push({
      id: `act-${randomUUID().slice(0, 8)}`,
      tool,
      args: args ?? {},
      result,
      error,
      createdAt: new Date().toISOString(),
    });
    save();
  }

  return {
    data,
    save,
    dedup,
    upsertCustomer,
    addJob,
    nextJob,
    jobForPhone,
    thread: (k) => data.threads[k],
    setThread,
    logAction,
  };
}

module.exports = { createStore };
