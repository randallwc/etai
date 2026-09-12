const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJobPacket } = require("../packet.js");

const JOB = {
  id: "job-1",
  description: "fix my sink",
  window: { start: "2026-09-13T16:00:00.000Z", end: "2026-09-13T17:00:00.000Z" },
};
const CUSTOMER = { id: "cust-1", phone: "+15551234567", name: "Marta", ambiguousCrmId: "crm-1" };

function fakeAmbi(overrides = {}) {
  return {
    createForm: async (b) => ({ id: "form-1", slug: "intake-x", workspace_slug: "ws", public_url: "https://app.ambiguous.ai/f/ws/intake-x", ...b }),
    createDocument: async (b) => ({ id: "doc-1", ...b }),
    createSignDraft: async (b) => ({ id: "sign-1", status: "draft", ...b }),
    createDeal: async (b) => ({ id: "deal-1", ...b }),
    createTask: async (b) => ({ id: "task-1", ...b }),
    logActivity: async (b) => ({ id: "act-1", ...b }),
    ...overrides,
  };
}

test("packet creates form, doc, sign draft, deal, task, and activity", async () => {
  const calls = [];
  const ambi = fakeAmbi();
  for (const k of Object.keys(ambi)) {
    const fn = ambi[k];
    ambi[k] = async (b) => { calls.push([k, b]); return fn(b); };
  }
  const p = await createJobPacket({
    ambi, job: JOB, customer: CUSTOMER, location: "22 main st",
    when: "Sun, 9/13 at 9:00 AM", now: () => new Date("2026-09-12T22:00:00Z"),
  });
  assert.deepEqual(p.errors, []);
  assert.equal(p.formId, "form-1");
  assert.equal(p.formUrl, "https://app.ambiguous.ai/f/ws/intake-x");
  assert.equal(p.documentId, "doc-1");
  assert.equal(p.signDocumentId, "sign-1");
  assert.equal(p.dealId, "deal-1");
  assert.equal(p.taskId, "task-1");
  const signCall = calls.find(([k]) => k === "createSignDraft");
  assert.equal(signCall[1].sourceDocId, "doc-1");
  assert.equal(signCall[1].signer, null);
  const taskCall = calls.find(([k]) => k === "createTask");
  assert.equal(taskCall[1].contact_id, "crm-1");
  assert.equal(taskCall[1].deal_id, "deal-1");
  assert.equal(taskCall[1].due_date, "2026-09-13");
  assert.ok(calls.some(([k]) => k === "logActivity"));
});

test("a customer with an email gets a signer and a prepared sign doc", async () => {
  const calls = [];
  const ambi = fakeAmbi({
    createSignDraft: async (b) => { calls.push(["createSignDraft", b]); return { id: "sign-2", status: "preview_pending" }; },
  });
  const p = await createJobPacket({
    ambi, job: JOB, customer: { ...CUSTOMER, email: "marta@example.com" },
    location: null, when: "Sun, 9/13",
  });
  assert.equal(p.signStatus, "preview_pending");
  assert.deepEqual(calls[0][1].signer, { email: "marta@example.com", name: "Marta" });
});

test("a failed step lands in errors and the rest still complete", async () => {
  const ambi = fakeAmbi({
    createForm: async () => { throw new Error("forms down"); },
    createSignDraft: async () => { throw new Error("sign down"); },
  });
  const p = await createJobPacket({ ambi, job: JOB, customer: CUSTOMER, location: null, when: "x" });
  assert.equal(p.formId, undefined);
  assert.equal(p.documentId, "doc-1");
  assert.equal(p.dealId, "deal-1");
  assert.deepEqual(p.errors.map((e) => e.step).sort(), ["form", "sign_draft"]);
});

test("no crm id skips deal and activity; no doc skips sign", async () => {
  const calls = [];
  const ambi = fakeAmbi({
    createDocument: async () => { throw new Error("docs down"); },
  });
  for (const k of Object.keys(ambi)) {
    const fn = ambi[k];
    ambi[k] = async (b) => { calls.push(k); return fn(b); };
  }
  const p = await createJobPacket({
    ambi, job: JOB, customer: { id: "c2", phone: "+15550000000" }, location: null, when: "x",
  });
  assert.equal(p.dealId, undefined);
  assert.equal(p.signDocumentId, undefined);
  assert.ok(!calls.includes("createDeal"));
  assert.ok(!calls.includes("logActivity"));
  assert.ok(!calls.includes("createSignDraft"));
});
