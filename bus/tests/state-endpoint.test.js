const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { createBusServer } = require("../index.js");
const { createStore } = require("../state.js");

let server, base, store;

before(async () => {
  store = createStore(null);
  ({ server } = createBusServer(
    { CONTRACT_PHONE: "+15550001111" },
    {
      store,
      notify: async () => {},
      loop: { handle: async () => "" },
      calendar: { stub: true },
      ambi: { enabled: false, createTask: async () => null },
      ai: { classify: async () => ({ intent: "other" }) },
    },
  ));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("GET /state returns empty arrays on a fresh store", async () => {
  const res = await fetch(`${base}/state`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jobs: [], customers: [], actions: [] });
});

test("GET /state reflects customers, jobs, and actions in the store", async () => {
  const customer = store.upsertCustomer("+15551234567", { name: "Sam" });
  const job = store.addJob({
    customerId: customer.id,
    contractorId: "contractor",
    ambiguousEventId: "evt_1",
    status: "confirmed",
    window: { start: "2026-09-14T17:00:00Z", end: "2026-09-14T18:00:00Z" },
    description: "sprinkler repair",
    source: "message",
  });
  store.logAction({ tool: "book_job", args: { slot: "x" }, result: { id: "evt_1" } });

  const res = await fetch(`${base}/state`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.customers.length, 1);
  assert.equal(body.customers[0].phone, "+15551234567");
  assert.equal(body.customers[0].name, "Sam");
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].id, job.id);
  assert.equal(body.jobs[0].status, "confirmed");
  assert.equal(body.actions.length, 1);
  assert.equal(body.actions[0].tool, "book_job");
});
