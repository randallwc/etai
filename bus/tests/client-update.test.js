const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createBusServer } = require("../index.js");
const { stubCalendar } = require("../calendar.js");
const { createStore } = require("../state.js");

const CONTRACTOR = "+15550001111";
const CLIENT = "+15557654321";
const CLIENT2 = "+15557654322";
const UNKNOWN = "+15559999999";

function fakeIntent(body) {
  const s = body.toLowerCase();
  if (/move|resched/.test(s)) return { intent: "reschedule", dayRef: "friday" };
  if (/cancel/.test(s)) return { intent: "cancel" };
  if (/need|book|come|fix/.test(s)) {
    return { intent: "book", dayRef: "tomorrow", description: body, location: "1 Main St" };
  }
  return { intent: "other" };
}

async function serve() {
  const sent = [];
  const calendar = stubCalendar();
  const store = createStore(null);
  const { server } = createBusServer(
    { CONTRACT_PHONE: CONTRACTOR, CONTRACTOR_TZ: "UTC" },
    {
      ai: { classify: async (b) => fakeIntent(b) },
      calendar,
      store,
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
  const update = (phone) =>
    fetch(`${base}/internal/client-update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(phone ? { phone } : {}),
    });
  const until = async (n) => {
    for (let i = 0; i < 60 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(sent.length >= n, `expected ${n} sends, got ${sent.length}`);
  };
  return { server, sent, store, inbound, update, until };
}

test("broadcast texts each client with a confirmed job; jobless customers get nothing", async () => {
  const { server, sent, store, inbound, update, until } = await serve();
  try {
    await inbound("b1", "book sprinklers tomorrow");
    await inbound("b2", "1");
    await until(3);
    await inbound("b3", "need a quote tomorrow", CLIENT2);
    await until(4);

    const res = await update();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sent: 1 });
    await until(5);
    assert.equal(sent[4].to, CLIENT);
    assert.match(sent[4].body, /^you have book sprinklers tomorrow \w+, \d+\/\d+ at \d+:\d+ [AP]M\. reply with a new day or time to move it\.$/i);
    assert.equal(sent.filter((s) => s.to === CLIENT2).length, 1);
    assert.ok(store.data.actions.some((a) => a.tool === "client_update" && !a.error));
  } finally {
    server.close();
  }
});

test("{phone} scopes the update to that client only", async () => {
  const { server, sent, inbound, update, until } = await serve();
  try {
    await inbound("p1", "book sprinklers tomorrow");
    await inbound("p2", "1");
    await until(3);
    await inbound("p3", "book gutters tomorrow", CLIENT2);
    await inbound("p4", "1", CLIENT2);
    await until(6);

    const res = await update(CLIENT2);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sent: 1 });
    await until(7);
    assert.equal(sent[6].to, CLIENT2);
    assert.match(sent[6].body, /gutters/i);
    assert.match(sent[6].body, /reply with a new day or time/i);
    assert.equal(sent.filter((s) => s.to === CLIENT).length, 2);
  } finally {
    server.close();
  }
});

test("given phone with no job -> 400 and nothing sent", async () => {
  const { server, sent, inbound, update, until } = await serve();
  try {
    await inbound("u1", "book sprinklers tomorrow");
    await inbound("u2", "1");
    await until(3);
    await inbound("u3", "need a quote tomorrow", CLIENT2);
    await until(4);

    const jobless = await update(CLIENT2);
    assert.equal(jobless.status, 400);
    const unknown = await update(UNKNOWN);
    assert.equal(unknown.status, 400);
    assert.equal(sent.length, 4);
  } finally {
    server.close();
  }
});
