const { randomUUID } = require("node:crypto");

const seen = new Set();
const customers = new Map();
const jobs = new Map();
const pendingByThread = new Map();

function dedup(externalId) {
  if (seen.has(externalId)) return false;
  if (seen.size >= 5000) seen.delete(seen.values().next().value);
  seen.add(externalId);
  return true;
}

function customerByPhone(phone) {
  if (!customers.has(phone)) {
    customers.set(phone, {
      id: randomUUID(),
      phone,
      name: null,
      address: null,
    });
  }
  return customers.get(phone);
}

function addJob(job) {
  const id = job.id ?? randomUUID();
  const record = { ...job, id };
  jobs.set(id, record);
  return record;
}

function jobsForCustomer(customerId) {
  return [...jobs.values()].filter((j) => j.customerId === customerId);
}

function pending(threadKey) {
  return pendingByThread.get(threadKey);
}

function setPending(threadKey, pendingValue) {
  pendingByThread.set(threadKey, pendingValue);
}

function clearPending(threadKey) {
  pendingByThread.delete(threadKey);
}

module.exports = {
  dedup,
  customerByPhone,
  addJob,
  jobsForCustomer,
  pending,
  setPending,
  clearPending,
};
