const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createBusServer } = require("../index.js");
const { stubCalendar } = require("../calendar.js");

const CONTRACTOR = "+15550001111";

async function serve({ classify, notify: notifyOverride, seed, env = {} } = {}) {
  const sent = [];
  let notifyCalls = 0;
  const calendar = stubCalendar("UTC");
  const { server, store } = createBusServer(
    { CONTRACT_PHONE: CONTRACTOR, CONTRACTOR_TZ: "UTC", SEND_RETRY_MS: "5", ...env },
    {
      ai: { classify },
      calendar,
      notify:
        notifyOverride ??
        (async ({ to, body }) => {
          notifyCalls += 1;
          sent.push({ to, body });
          return { externalId: `n-${sent.length}` };
        }),
    }
  );
  if (seed) await seed(calendar, store);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const inbound = (externalId, body, from = "+15551234567") =>
    fetch(`${base}/webhooks/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "imessage", from, body, externalId,
        receivedAt: new Date().toISOString(), threadKey: from,
      }),
    });
  const until = async (fn, label = "condition") => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fn(), `timed out waiting for ${label}`);
  };
  return { server, sent, store, calendar, inbound, until, getCalls: () => notifyCalls };
}

test("parallel inbounds on different threads each get one reply, no lost turns", async () => {
  const { server, sent, inbound, until } = await serve({
    classify: async (b) => ({ intent: "book", description: b, dayRef: "tomorrow" }),
  });
  try {
    const phones = ["+15551110001", "+15551110002", "+15551110003", "+15551110004", "+15551110005"];
    await Promise.all(phones.map((p, i) => inbound(`b-${i}`, `job ${i}` , p)));
    await until(() => sent.length >= phones.length, "5 replies");
    const replied = new Set(sent.map((s) => s.to));
    for (const p of phones) {
      assert.ok(replied.has(p), `no reply to ${p}`);
      assert.equal(sent.filter((s) => s.to === p).length, 1, `duplicate reply to ${p}`);
    }
  } finally {
    server.close();
  }
});

test("same-thread 'book' + slot pick fired in parallel still lock in exactly once", async () => {
  const from = "+15552220000";
  const { server, sent, store, calendar, inbound, until } = await serve({
    classify: async () => ({ intent: "book", description: "sprinklers", dayRef: "tomorrow" }),
  });
  try {
    await Promise.all([inbound("r-1", "need sprinklers tomorrow", from), inbound("r-2", "1", from)]);
    await until(() => sent.length >= 2, "two replies");
    assert.match(sent.find((s) => /Locked in/.test(s.body)).body, /Locked in/);
    const events = await calendar.listDay({ date: new Date(Date.now() + 86400000).toISOString().slice(0, 10) });
    assert.equal(events.filter((e) => e.status !== "canceled").length, 1);
    assert.equal(store.thread(from).pendingProposal ?? null, null);
  } finally {
    server.close();
  }
});

test("turns on different threads run in parallel, not behind one global queue", async () => {
  const { server, sent, inbound, until } = await serve({
    classify: async () => {
      await new Promise((r) => setTimeout(r, 250));
      return { intent: "day_summary" };
    },
  });
  try {
    const phones = ["+15554440001", "+15554440002", "+15554440003"];
    const t0 = Date.now();
    await Promise.all(phones.map((p, i) => inbound(`w-${i}`, "what's my day?", p)));
    await until(() => sent.length >= phones.length, "all replies");
    assert.ok(Date.now() - t0 < 700, `parallel turns took ${Date.now() - t0}ms — global serialization`);
  } finally {
    server.close();
  }
});

test("a failed send is retried once, so the client still gets the reply", async () => {
  const sent = [];
  let calls = 0;
  const { server, inbound, until } = await serve({
    classify: async () => ({ intent: "day_summary" }),
    notify: async ({ to, body }) => {
      calls += 1;
      if (calls === 1) throw new Error("messaging down");
      sent.push({ to, body });
      return { externalId: `n-${calls}` };
    },
  });
  try {
    await inbound("f-1", "what's my day?");
    await until(() => sent.length === 1, "retried reply");
    assert.equal(calls, 2);
    assert.match(sent[0].body, /Nothing booked|booked/i);
  } finally {
    server.close();
  }
});

test("a turn that dies entirely does not jam the queue for the next text", async () => {
  const sent = [];
  const { server, inbound, until } = await serve({
    classify: async (b) => {
      if (b === "explode") throw new Error("provider down");
      return { intent: "day_summary" };
    },
    notify: async ({ to, body }) => {
      if (sent.length === 0 && /couldn't reach/.test(body)) {
        sent.push({ to, body });
        throw new Error("send also down");
      }
      sent.push({ to, body });
      return { externalId: "ok" };
    },
  });
  try {
    await inbound("q-1", "explode");
    await until(() => sent.some((s) => /couldn't reach/.test(s.body)), "apology attempt");
    await inbound("q-2", "what's my day?");
    await until(() => sent.some((s) => /Nothing booked|booked/i.test(s.body)), "next turn reply");
  } finally {
    server.close();
  }
});

test("a timed-out turn still gets a soft-ack text instead of silence", async () => {
  const { server, sent, inbound, until } = await serve({
    classify: () => new Promise(() => {}),
    env: { TURN_TIMEOUT_MS: "80" },
  });
  try {
    await inbound("to-1", "hang me");
    await until(() => sent.some((s) => /recorded shortly/.test(s.body)), "soft-ack");
  } finally {
    server.close();
  }
});

test("a slow turn sends the working beat first, then the real reply", async () => {
  const { server, sent, inbound, until } = await serve({
    classify: async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { intent: "day_summary" };
    },
    env: { WORKING_BEAT_MS: "30" },
  });
  try {
    await inbound("wb-1", "what's my day?");
    await until(() => sent.length >= 2, "beat + reply");
    assert.match(sent[0].body, /On it/);
    assert.match(sent[1].body, /Nothing booked|booked/i);
  } finally {
    server.close();
  }
});

test("a caller's name is learned into the customer record", async () => {
  const { server, store, inbound, until } = await serve({
    classify: async () => ({ intent: "day_summary" }),
  });
  try {
    await inbound("nm-1", "this is Dana, what's my day?");
    await until(() => Object.values(store.data.customers).some((c) => c.name === "Dana"), "name learned");
  } finally {
    server.close();
  }
});

test("ack and goodbye texts get short replies", async () => {
  const { server, sent, inbound, until } = await serve({
    classify: async () => ({ intent: "other" }),
  });
  try {
    await inbound("ak-1", "sounds good");
    await inbound("ak-2", "that's all");
    await until(() => sent.length >= 2, "two replies");
    assert.match(sent[0].body, /Got it/);
    assert.match(sent[1].body, /Talk soon/);
  } finally {
    server.close();
  }
});

test("two clients picking the same open slot: one locks in, the loser gets fresh alternates", async () => {
  const A = "+15553330001";
  const B = "+15553330002";
  const { server, sent, calendar, inbound, until } = await serve({
    classify: async (b) => ({ intent: "book", description: /gutter/.test(b) ? "gutter clean" : "site visit", dayRef: "tomorrow" }),
  });
  try {
    await Promise.all([inbound("p-a1", "book a visit", A), inbound("p-b1", "book gutter clean", B)]);
    await until(() => sent.filter((s) => /which works/i.test(s.body)).length === 2, "two proposals");
    await Promise.all([inbound("p-a2", "1", A), inbound("p-b2", "1", B)]);
    await until(() => sent.some((s) => /Locked in/.test(s.body)) && sent.some((s) => /just taken/.test(s.body)), "lock + filled");
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const events = (await calendar.listDay({ date })).filter((e) => e.status !== "canceled");
    assert.equal(events.length, 1);
    const loser = sent.find((s) => /just taken/.test(s.body)).to;
    const reoffer = sent.filter((s) => s.to === loser).at(-1);
    assert.match(reoffer.body, /which works/i);
  } finally {
    server.close();
  }
});
