const assert = require("node:assert/strict");
const { test, afterEach } = require("node:test");
const { createAmbiguous } = require("../ambiguous.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return typeof handler === "function" ? handler(url, options) : handler;
  };
  return calls;
}

test("enabled is false without an api key and true with either env var", () => {
  assert.equal(createAmbiguous({}).enabled, false);
  assert.equal(createAmbiguous({ AMBIG_API: "k" }).enabled, true);
  assert.equal(createAmbiguous({ AMBIGUOUS_API_KEY: "k" }).enabled, true);
});

test("api builds /api-prefixed urls with auth and version headers", async () => {
  const calls = stubFetch(jsonRes({ ok: 1 }));
  const ambi = createAmbiguous({ AMBIG_API: "k" });
  await ambi.api("/users");
  assert.equal(calls[0].url, "https://app.ambiguous.ai/api/users");
  assert.equal(calls[0].options.headers.authorization, "Bearer k");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.equal(calls[0].options.headers["API-Version"], "1");
});

test("AMBIGUOUS_BASE_URL overrides the default base and loses its trailing slash", async () => {
  const calls = stubFetch(jsonRes({}));
  const ambi = createAmbiguous({ AMBIG_API: "k", AMBIGUOUS_BASE_URL: "https://staging.test/" });
  await ambi.api("/ping");
  assert.equal(calls[0].url, "https://staging.test/api/ping");
});

test("api maps error statuses to codes", async () => {
  const ambi = createAmbiguous({ AMBIG_API: "k" });
  const cases = [
    [404, "not_found"],
    [401, "auth"],
    [403, "auth"],
    [500, "upstream"],
  ];
  for (const [status, code] of cases) {
    stubFetch(jsonRes({ message: "x" }, status));
    await assert.rejects(ambi.api("/x"), (e) => e.code === code && e.status === status);
  }
});

test("users, calendars, and events unwrap .data", async () => {
  const calls = stubFetch((url) => {
    if (url.includes("/calendars/events")) return jsonRes({ data: [{ id: "e1" }] });
    if (url.includes("/calendars")) return jsonRes({ data: [{ id: "cal1" }] });
    return jsonRes({ data: [{ id: "u1" }] });
  });
  const ambi = createAmbiguous({ AMBIG_API: "k" });
  assert.deepEqual(await ambi.users(), [{ id: "u1" }]);
  assert.deepEqual(await ambi.calendars(), [{ id: "cal1" }]);
  assert.deepEqual(await ambi.events("s", "e"), [{ id: "e1" }]);
  assert.match(calls[2].url, /\/api\/calendars\/events\?start=s&end=e/);
});

test("busySlots unwraps availability for the requested user", async () => {
  stubFetch(jsonRes({ availability: { u1: [{ start: "s" }] } }));
  const ambi = createAmbiguous({ AMBIG_API: "k" });
  assert.deepEqual(await ambi.busySlots("u1", "s", "e"), [{ start: "s" }]);
  stubFetch(jsonRes({ availability: {} }));
  assert.deepEqual(await ambi.busySlots("u1", "s", "e"), []);
});

test("createEvent posts and returns .event, updateEvent patches, deleteEvent deletes", async () => {
  const calls = stubFetch((url, options) => {
    if (options.method === "POST") return jsonRes({ event: { id: "e1" } });
    if (options.method === "PATCH") return jsonRes({ id: "e1", patched: true });
    return jsonRes({});
  });
  const ambi = createAmbiguous({ AMBIG_API: "k" });
  assert.deepEqual(await ambi.createEvent("cal1", { title: "t" }), { id: "e1" });
  assert.equal(calls[0].url, "https://app.ambiguous.ai/api/calendars/cal1/events");
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: "t" });
  assert.deepEqual(await ambi.updateEvent("e1", { title: "t2" }), { id: "e1", patched: true });
  assert.equal(calls[1].url, "https://app.ambiguous.ai/api/calendars/events/e1");
  assert.equal(calls[1].options.method, "PATCH");
  await ambi.deleteEvent("e1");
  assert.equal(calls[2].url, "https://app.ambiguous.ai/api/calendars/events/e1");
  assert.equal(calls[2].options.method, "DELETE");
});

test("findContact matches a contact by stripped digits", async () => {
  stubFetch(
    jsonRes({ data: [{ id: "c1", name: "Jane", phone: "+1 (555) 000-1111" }, { id: "c2", phone: "+1999" }] })
  );
  const ambi = createAmbiguous({ AMBIG_API: "k" });
  assert.equal((await ambi.findContact("15550001111")).id, "c1");
  assert.equal(await ambi.findContact("777"), null);
});

test("upsertContact returns an existing contact when the name matches", async () => {
  const calls = stubFetch(
    jsonRes({ data: [{ id: "c1", name: "Jane", phone: "+1 (555) 000-1111" }] })
  );
  const ambi = createAmbiguous({ AMBIG_API: "k" });
  const c = await ambi.upsertContact({ name: "Jane", phone: "15550001111" });
  assert.equal(c.id, "c1");
  assert.equal(calls.length, 1);
});

test("upsertContact patches when the name differs and posts when absent", async () => {
  const calls = stubFetch((url, options) => {
    if (url.includes("/crm/contacts?")) {
      return jsonRes({ data: url.includes("q=111") ? [] : [{ id: "c1", name: "Jane", phone: "+1 (555) 000-1111" }] });
    }
    if (options.method === "PATCH") return jsonRes({ contact: { id: "c1", name: "Janet" } });
    return jsonRes({ contact: { id: "c9" } });
  });
  const ambi = createAmbiguous({ AMBIG_API: "k" });
  assert.deepEqual(await ambi.upsertContact({ name: "Janet", phone: "15550001111" }), { id: "c1", name: "Janet" });
  assert.equal(calls[1].url, "https://app.ambiguous.ai/api/crm/contacts/c1");
  assert.equal(calls[1].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: "Janet" });
  assert.deepEqual(await ambi.upsertContact({ name: "Bob", phone: "111" }), { id: "c9" });
  assert.equal(calls[3].options.method, "POST");
  assert.equal(calls[3].url, "https://app.ambiguous.ai/api/crm/contacts");
  assert.deepEqual(JSON.parse(calls[3].options.body), { type: "person", name: "Bob", phone: "111" });
});

test("createTask returns .task and assistantChat posts the agent context", async () => {
  const calls = stubFetch((url) => {
    if (url.includes("/assistant/chat")) return jsonRes({ response: "hi" });
    return jsonRes({ task: { id: "t1" } });
  });
  const ambi = createAmbiguous({ AMBIG_API: "k" });
  assert.deepEqual(await ambi.createTask("call the bank"), { id: "t1" });
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: "call the bank" });
  assert.deepEqual(await ambi.assistantChat("hello"), { response: "hi" });
  assert.equal(calls[1].url, "https://app.ambiguous.ai/api/assistant/chat");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    message: "hello",
    context: { audience: "agent" },
  });
});
