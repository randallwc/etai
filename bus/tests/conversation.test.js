const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { createBusServer } = require("../index.js");
const { stubCalendar } = require("../calendar.js");

const CONTRACTOR = "+15550001111";
const CLIENT = "+15551234567";

async function serve({ classify, seedJobs } = {}) {
  const sent = [];
  const seenCtx = [];
  const calendar = stubCalendar("UTC");
  const { server, store } = createBusServer(
    { CONTRACT_PHONE: CONTRACTOR, CONTRACTOR_TZ: "UTC" },
    {
      ai: {
        classify: async (body, ctx) => {
          seenCtx.push({ body, ctx });
          return classify(body, ctx);
        },
      },
      calendar,
      notify: async ({ to, body }) => {
        sent.push({ to, body });
        return { externalId: `n-${sent.length}` };
      },
    }
  );
  if (seedJobs) {
    const cust = store.upsertCustomer(CLIENT, {});
    for (const [i, j] of seedJobs.entries()) {
      store.addJob({
        customerId: cust.id,
        contractorId: "contractor",
        ambiguousEventId: `ev-${i}`,
        status: "confirmed",
        window: j.window,
        description: j.description,
        source: "message",
      });
    }
  }
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
  return { server, sent, store, calendar, seenCtx, inbound, until };
}

const JOB_A = { description: "sprinkler repair", window: { start: "2026-09-17T15:00:00Z", end: "2026-09-17T16:00:00Z" } };
const JOB_B = { description: "water heater", window: { start: "2026-09-18T18:00:00Z", end: "2026-09-18T19:00:00Z" } };

test("classify gets context: role, jobs, and history", async () => {
  const { server, sent, seenCtx, inbound, until } = await serve({
    seedJobs: [JOB_A],
    classify: async () => ({ intent: "day_summary" }),
  });
  try {
    await inbound("h1", "what's my day?");
    await until(1);
    const ctx = seenCtx[0].ctx;
    assert.equal(ctx.role, "client");
    assert.equal(ctx.jobs.length, 1);
    assert.match(ctx.jobs[0].description, /sprinkler/);
    assert.deepEqual(ctx.history, []);
    await inbound("h2", "and tomorrow?");
    await until(2);
    assert.equal(seenCtx[1].ctx.history.length, 3);
    assert.equal(seenCtx[1].ctx.history[0].role, "them");
    assert.equal(seenCtx[1].ctx.history[1].role, "etai");
    assert.equal(seenCtx[1].ctx.history[2].body, "and tomorrow?");
  } finally {
    server.close();
  }
});

test("clarify texts the question, stores pendingClarify, and the answer is re-classified with it in history", async () => {
  const calls = [];
  const { server, sent, store, inbound, until } = await serve({
    classify: async (body) => {
      calls.push(body);
      if (/^something/.test(body)) {
        return { intent: "clarify", question: "Book a new visit, or move an existing one?" };
      }
      return { intent: "book", dayRef: "tomorrow", description: body };
    },
  });
  try {
    await inbound("k1", "something with the sprinklers");
    await until(1);
    assert.equal(sent[0].body, "Book a new visit, or move an existing one?");
    assert.ok(store.thread(CLIENT).pendingClarify);
    await inbound("k2", "book a new one tomorrow");
    await until(2);
    assert.match(sent[1].body, /which works/i);
    assert.equal(store.thread(CLIENT).pendingClarify ?? null, null);
    assert.ok(calls[1] !== undefined);
  } finally {
    server.close();
  }
});

test("jobRef picks the named job for reschedule; a miss asks which one", async () => {
  const { server, sent, store, inbound, until } = await serve({
    seedJobs: [JOB_A, JOB_B],
    classify: async (body) =>
      /heater/.test(body)
        ? { intent: "reschedule", jobRef: "water heater" }
        : /thing/.test(body)
          ? { intent: "reschedule", jobRef: "nonexistent job" }
          : { intent: "other" },
  });
  const OTHER = "+15559998888";
  const otherCust = store.upsertCustomer(OTHER, {});
  store.addJob({
    customerId: otherCust.id, contractorId: "contractor", ambiguousEventId: "ev-x",
    status: "confirmed", window: JOB_A.window, description: "deck staining", source: "message",
  });
  try {
    await inbound("j1", "move the water heater");
    await until(1);
    const p = store.thread(CLIENT).pendingProposal;
    assert.ok(p);
    const heaterJob = Object.values(store.data.jobs).find((j) => /heater/.test(j.description));
    assert.equal(p.jobId, heaterJob.id);
    await inbound("j2", "move the thing", OTHER);
    await until(2);
    assert.match(sent[1].body, /which visit/i);
  } finally {
    server.close();
  }
});

test("jobRef by time matches the job's start hour", async () => {
  const { server, sent, store, inbound, until } = await serve({
    seedJobs: [JOB_A, JOB_B],
    classify: async () => ({ intent: "reschedule", jobRef: "6:00 pm" }),
  });
  try {
    await inbound("t1", "move my 6pm");
    await until(1);
    const heaterJob = Object.values(store.data.jobs).find((j) => /heater/.test(j.description));
    assert.equal(store.thread(CLIENT).pendingProposal.jobId, heaterJob.id);
  } finally {
    server.close();
  }
});

test("other uses the model-drafted say text", async () => {
  const { server, sent, inbound, until } = await serve({
    classify: async () => ({ intent: "other", say: "Ha, nice one. I only do scheduling though." }),
  });
  try {
    await inbound("s1", "tell me a joke");
    await until(1);
    assert.equal(sent[0].body, "Ha, nice one. I only do scheduling though.");
  } finally {
    server.close();
  }
});

test("same-client duplicate booking warns, and a repeat asks proceeds", async () => {
  const { server, sent, store, inbound, until } = await serve({
    seedJobs: [JOB_A],
    classify: async () => ({ intent: "book", description: "sprinkler repair", dayRef: "friday" }),
  });
  try {
    await inbound("d1", "need sprinkler repair friday");
    await until(1);
    assert.match(sent[0].body, /already have.*move it|second visit/i);
    assert.equal(store.thread(CLIENT).pendingProposal ?? null, null);
    assert.equal(Object.keys(store.data.jobs).length, 1);
    await inbound("d2", "book sprinklers again anyway");
    await until(2);
    assert.match(sent[1].body, /which works/i);
    assert.ok(store.thread(CLIENT).pendingProposal);
  } finally {
    server.close();
  }
});

test("a stale dedup warning expires: re-asking warns again instead of booking silently", async () => {
  const { server, sent, store, inbound, until } = await serve({
    seedJobs: [JOB_A],
    classify: async () => ({ intent: "book", description: "sprinkler repair", dayRef: "friday" }),
  });
  try {
    const job = Object.values(store.data.jobs)[0];
    store.setThread(CLIENT, {
      pendingDedup: { jobId: job.id, at: new Date(Date.now() - 60 * 60000).toISOString() },
    });
    await inbound("dx1", "need sprinkler repair friday");
    await until(1);
    assert.match(sent[0].body, /already have/i);
    assert.ok(store.thread(CLIENT).pendingDedup);
    assert.equal(store.thread(CLIENT).pendingProposal ?? null, null);
    assert.equal(Object.keys(store.data.jobs).length, 1);
  } finally {
    server.close();
  }
});

test("a stale clarify question expires instead of steering the next classify", async () => {
  const { server, sent, store, seenCtx, inbound, until } = await serve({
    classify: async () => ({ intent: "day_summary" }),
  });
  try {
    store.setThread(CLIENT, {
      pendingClarify: { question: "Book a new visit, or move one?", at: new Date(Date.now() - 60 * 60000).toISOString() },
    });
    await inbound("cx1", "what's my day?");
    await until(1);
    assert.equal(seenCtx[0].ctx.pending ?? null, null);
    assert.equal(store.thread(CLIENT).pendingClarify ?? null, null);
  } finally {
    server.close();
  }
});

test("an event already on the calendar refuses a duplicate create", async () => {
  const { server, sent, store, calendar, inbound, until } = await serve({
    classify: async (b) =>
      /^\d+$/.test(b.trim()) ? { intent: "book", slotChoice: +b.trim() } : { intent: "book", description: "sprinkler repair", dayRef: "tomorrow" },
  });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await calendar.createEvent({
    title: "sprinkler repair — existing",
    start: `${tomorrow}T18:00:00Z`,
    end: `${tomorrow}T19:00:00Z`,
  });
  try {
    await inbound("e1", "need sprinkler repair tomorrow");
    await until(1);
    assert.match(sent[0].body, /which works/i);
    await inbound("e2", "1");
    await until(2);
    assert.match(sent[1].body, /already on the calendar/i);
    assert.equal(store.thread(CLIENT).pendingProposal ?? null, null);
    assert.equal(Object.keys(store.data.jobs).length, 0);
  } finally {
    server.close();
  }
});

test("thread history is capped at 8 and survives on the store", async () => {
  const { server, store, inbound, until } = await serve({
    classify: async () => ({ intent: "day_summary" }),
  });
  try {
    for (let i = 0; i < 6; i++) await inbound(`cap-${i}`, `message ${i}`);
    await until(6);
    const hist = store.thread(CLIENT).history;
    assert.equal(hist.length, 8);
    assert.equal(hist[0].body, "message 2");
  } finally {
    server.close();
  }
});

after(() => {});
