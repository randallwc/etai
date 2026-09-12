const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAgentServer } = require("../index.js");
const { stubCalendar } = require("../calendar.js");

const CONTRACTOR = "+15550001111";
const CLIENT = "+15557654321";

async function serve({ upsertContact }) {
  const sent = [];
  const calls = [];
  const calendar = stubCalendar();
  const { server, store } = createAgentServer(
    { CONTRACT_PHONE: CONTRACTOR, CONTRACTOR_TZ: "UTC" },
    {
      ambi: {
        enabled: true,
        upsertContact: async (c) => {
          calls.push(c);
          return upsertContact(c);
        },
        createTask: async (t) => ({ title: t }),
      },
      ai: {
        classify: async (body) =>
          /book|need/.test(body.toLowerCase())
            ? { intent: "book", dayRef: "tomorrow", name: "Jane", description: body }
            : { intent: "other" },
      },
      calendar,
      notify: async ({ to, body }) => {
        sent.push({ to, body });
        return { externalId: `n-${sent.length}` };
      },
    }
  );
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const inbound = (externalId, body, from = CLIENT) =>
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
  return { server, sent, store, calls, inbound, until };
}

test("booking a client upserts them into the CRM with name and phone", async () => {
  const { server, sent, store, calls, inbound, until } = await serve({
    upsertContact: async () => ({ id: "crm-42" }),
  });
  try {
    await inbound("b1", "need sprinklers fixed tomorrow");
    await until(1);
    await inbound("b2", "1");
    await until(3);
    assert.deepEqual(calls, [{ name: "Jane", phone: CLIENT }]);
    assert.equal(store.data.customers[CLIENT].ambiguousCrmId, "crm-42");
    assert.match(sent[1].body, /locked in/i);
    assert.equal(sent[2].to, CONTRACTOR);
    assert.match(sent[2].body, /new booking/i);
    const logged = store.data.actions.filter((a) => a.tool === "crm_upsert_contact");
    assert.equal(logged.length, 1);
    assert.equal(logged[0].result.id, "crm-42");
  } finally {
    server.close();
  }
});

test("CRM failure is non-fatal: booking completes and the error is action-logged", async () => {
  const { server, sent, store, calls, inbound, until } = await serve({
    upsertContact: async () => {
      throw new Error("Ambiguous /crm/contacts -> 503");
    },
  });
  try {
    await inbound("f1", "book a visit tomorrow");
    await until(1);
    await inbound("f2", "1");
    await until(3);
    assert.match(sent[1].body, /locked in/i);
    assert.equal(sent[2].to, CONTRACTOR);
    assert.equal(store.data.customers[CLIENT].ambiguousCrmId, undefined);
    const logged = store.data.actions.filter((a) => a.tool === "crm_upsert_contact");
    assert.ok(logged.length >= 1);
    assert.match(logged[0].error, /503/);
    assert.ok(calls.length >= 1);
    assert.deepEqual(calls[0], { name: "Jane", phone: CLIENT });
  } finally {
    server.close();
  }
});

test("an unknown-name client still syncs to the CRM keyed by phone", async () => {
  const sent = [];
  const calls = [];
  const calendar = stubCalendar();
  const { server } = createAgentServer(
    { CONTRACT_PHONE: CONTRACTOR, CONTRACTOR_TZ: "UTC" },
    {
      ambi: {
        enabled: true,
        upsertContact: async (c) => {
          calls.push(c);
          return { id: "crm-7" };
        },
        createTask: async (t) => ({ title: t }),
      },
      ai: {
        classify: async () => ({ intent: "book", dayRef: "tomorrow", name: null, description: "x" }),
      },
      calendar,
      notify: async ({ to, body }) => {
        sent.push({ to, body });
        return { externalId: "n" };
      },
    }
  );
  await new Promise((r) => server.listen(0, r));
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/webhooks/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "imessage", from: CLIENT, body: "book", externalId: "u1",
        receivedAt: new Date().toISOString(), threadKey: CLIENT,
      }),
    });
    for (let i = 0; i < 60 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls, [{ name: null, phone: CLIENT }]);
  } finally {
    server.close();
  }
});
