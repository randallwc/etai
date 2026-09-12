const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAgentServer } = require("../index.js");
const { stubCalendar } = require("../calendar.js");

const CONTRACTOR = "+15550001111";
const CUSTOMER = "+15559990001";

function fakeIntent(body) {
  const s = body.toLowerCase();
  if (/where|eta|when|arriving|how far/.test(s)) return { intent: "eta" };
  if (/cancel/.test(s)) return { intent: "cancel" };
  return { intent: "other" };
}

async function serve() {
  const sent = [];
  const { server, store } = createAgentServer(
    { CONTRACT_PHONE: CONTRACTOR, CONTRACTOR_TZ: "UTC" },
    {
      ai: { classify: async (b) => fakeIntent(b) },
      calendar: stubCalendar(),
      notify: async ({ to, body }) => {
        sent.push({ to, body });
        return { externalId: `n-${sent.length}` };
      },
    }
  );
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const inbound = (externalId, body, from = CUSTOMER) =>
    fetch(`${base}/webhooks/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "imessage", from, body, externalId,
        receivedAt: new Date().toISOString(), threadKey: from,
      }),
    });
  const until = async (n) => {
    for (let i = 0; i < 60 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(sent.length >= n, `expected ${n} sends, got ${sent.length}`);
  };
  return { server, sent, store, inbound, until };
}

function seedJob(store, fields = {}) {
  const cust = store.upsertCustomer(CUSTOMER, { name: "Sam" });
  const start = new Date(Date.now() + 3600000);
  return store.addJob({
    customerId: cust.id,
    contractorId: "contractor",
    ambiguousEventId: "evt-1",
    status: "en_route",
    window: { start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString() },
    address: "",
    description: "lock rekey",
    source: "message",
    eta: null,
    ...fields,
  });
}

test("customer eta request resends the stored ETA", async () => {
  const { server, sent, store, inbound, until } = await serve();
  try {
    const eta = new Date(Date.now() + 1800000);
    seedJob(store, { eta: eta.toISOString() });
    await inbound("e1", "where are you");
    await until(1);
    const want = eta.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
    assert.ok(sent.at(-1).body.includes(want));
    assert.match(sent.at(-1).body, /eta/i);
  } finally {
    server.close();
  }
});

test("customer eta request without a stored eta says an update is coming", async () => {
  const { server, sent, store, inbound, until } = await serve();
  try {
    seedJob(store);
    await inbound("e2", "when will you be here");
    await until(1);
    assert.match(sent.at(-1).body, /eta shortly/i);
  } finally {
    server.close();
  }
});

test("customer eta request with no job says so", async () => {
  const { server, sent, inbound, until } = await serve();
  try {
    await inbound("e3", "eta?");
    await until(1);
    assert.match(sent.at(-1).body, /no active job|don't see/i);
  } finally {
    server.close();
  }
});

test("customer ack gets a polite reply and no state change", async () => {
  const { server, sent, store, inbound, until } = await serve();
  try {
    const job = seedJob(store);
    await inbound("a1", "ok thanks");
    await until(1);
    assert.match(sent.at(-1).body, /got it|thanks/i);
    assert.equal(store.data.jobs[job.id].status, "en_route");
  } finally {
    server.close();
  }
});

test("contractor ack does not create a task", async () => {
  const { server, sent, inbound, until } = await serve();
  try {
    await inbound("a2", "ok", CONTRACTOR);
    await until(1);
    assert.match(sent.at(-1).body, /got it|thanks/i);
  } finally {
    server.close();
  }
});

test("customer cancel with no job says there is nothing to cancel", async () => {
  const { server, sent, inbound, until } = await serve();
  try {
    await inbound("c1", "cancel");
    await until(1);
    assert.match(sent.at(-1).body, /don't see a booking/i);
  } finally {
    server.close();
  }
});
