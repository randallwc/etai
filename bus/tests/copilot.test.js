const test = require("node:test");
const assert = require("node:assert/strict");
const { createCopilot, collectRun } = require("../copilot.js");
const { createStore } = require("../state.js");
const { stubCalendar } = require("../calendar.js");
const { createBusServer } = require("../index.js");

function fakeObservable(events) {
  return {
    subscribe(obs) {
      try {
        for (const e of events) obs.next(e);
        obs.complete();
      } catch (err) {
        obs.error(err);
      }
    },
  };
}

makeFakeAgent.configs = [];
makeFakeAgent.inputs = [];

function makeFakeAgent(script) {
  return class {
    constructor(config) {
      this.config = config;
      makeFakeAgent.configs.push(config);
    }
    run(input) {
      makeFakeAgent.inputs.push(input);
      return fakeObservable(script(input));
    }
    abortRun() {
      this.aborted = true;
    }
  };
}

function textEvents(text) {
  return [
    { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: text },
    { type: "TEXT_MESSAGE_END", messageId: "m1" },
  ];
}

function msg(over = {}) {
  return {
    channel: "sms",
    from: "+15551234567",
    body: "hi",
    externalId: `x-${Math.random()}`,
    receivedAt: new Date().toISOString(),
    threadKey: "+15551234567",
    ...over,
  };
}

function deps(over = {}) {
  const sent = [];
  return {
    env: { COPILOT_AGENT: "on" },
    calendar: stubCalendar("America/Los_Angeles"),
    store: createStore(null),
    notify: async ({ to, body }) => {
      sent.push({ to, body });
      return { externalId: "n-1" };
    },
    chat: over.chat ?? (async () => ({ response: '{"say":"ok"}' })),
    contractorPhone: "+15550001111",
    tz: "America/Los_Angeles",
    sent,
    ...over,
  };
}

test("copilot handles sms and imessage once enabled", () => {
  const d = deps();
  const c = createCopilot({ ...d, AgentCtor: makeFakeAgent(() => textEvents("hi")) });
  assert.equal(c.enabled, true);
  assert.equal(c.handles("sms"), true);
  assert.equal(c.handles("imessage"), true);
  assert.equal(c.handles("voice"), false);
  assert.equal(c.handles("console"), false);
  const withModel = createCopilot({
    ...d,
    env: { COPILOT_MODEL: "openai/gpt-4.1-mini" },
    AgentCtor: makeFakeAgent(() => []),
  });
  assert.equal(withModel.enabled, true);
});

test("the path stays off without a model key or explicit opt-in", () => {
  const d = deps();
  const off = createCopilot({ ...d, env: { COPILOT_AGENT: "off" }, AgentCtor: makeFakeAgent(() => []) });
  assert.equal(off.enabled, false);
  const none = createCopilot({ ...d, env: {}, chat: null, AgentCtor: null });
  assert.equal(none.enabled, false);
  const chatOnly = createCopilot({ ...d, env: {}, AgentCtor: makeFakeAgent(() => []) });
  assert.equal(chatOnly.enabled, false);
});

test("a scripted run texts the reply back and records history", async () => {
  const sent = [];
  const store = createStore(null);
  const AgentCtor = makeFakeAgent(() => textEvents("On my way, 10 min out."));
  const c = createCopilot({
    ...deps({ notify: async (m) => sent.push(m) }),
    store,
    AgentCtor,
  });
  const reply = await c.handle(msg({ body: "where are you" }));
  assert.equal(reply, "On my way, 10 min out.");
  assert.deepEqual(sent.map((m) => m.to), ["+15551234567"]);
  const hist = store.thread("+15551234567").history;
  assert.deepEqual(hist.map((h) => h.role), ["them", "etai"]);
  assert.equal(makeFakeAgent.inputs.at(-1).threadId, "+15551234567");
});

test("run errors fall back to a plain-language reply", async () => {
  const sent = [];
  const AgentCtor = makeFakeAgent(() => [{ type: "RUN_ERROR", message: "boom" }]);
  const c = createCopilot({ ...deps({ notify: async (m) => sent.push(m) }), AgentCtor });
  const reply = await c.handle(msg());
  assert.match(reply, /sorry/i);
  assert.equal(sent.length, 1);
});

test("factory mode drives Ambiguous chat with a JSON tool contract", async () => {
  const sent = [];
  const store = createStore(null);
  const calendar = stubCalendar("America/Los_Angeles");
  const prompts = [];
  const chat = async (p) => {
    prompts.push(p);
    if (prompts.length === 1) {
      return { response: '{"tool":"get_availability","args":{"date":"tomorrow","durationMinutes":60}}' };
    }
    return { response: '{"say":"I have 9:30 AM open. Want it?"}' };
  };
  const AgentCtor = makeFakeAgent(() => []);
  const c = createCopilot({
    ...deps({ notify: async (m) => sent.push(m) }),
    store,
    calendar,
    chat,
    AgentCtor,
  });
  await c.handle(msg({ body: "book me tomorrow" }));
  const config = makeFakeAgent.configs.at(-1);
  assert.equal(config.type, "custom");
  const events = [];
  for await (const e of config.factory({
    input: { messages: [{ role: "user", content: "book me tomorrow" }] },
  })) {
    events.push(e);
  }
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_RESULT",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
  ]);
  const result = JSON.parse(events.find((e) => e.type === "TOOL_CALL_RESULT").content);
  assert.equal(result.date.length, 10);
  assert.equal(store.data.actions.at(-1).tool, "get_availability");
});

test("classic mode passes native tool defs when a model is configured", async () => {
  const AgentCtor = makeFakeAgent(() => textEvents("ok"));
  const c = createCopilot({
    ...deps(),
    env: { COPILOT_MODEL: "openai/gpt-4.1-mini" },
    AgentCtor,
  });
  assert.equal(c.enabled, true);
  await c.handle(msg({ body: "book me friday" }));
  const config = makeFakeAgent.configs.at(-1);
  assert.equal(config.model, "openai/gpt-4.1-mini");
  assert.ok(Array.isArray(config.tools));
  assert.ok(config.tools.some((t) => t.name === "book_job"));
  const input = makeFakeAgent.inputs.at(-1);
  assert.ok(input.tools.some((t) => t.name === "get_availability"));
  assert.ok(input.context.some((x) => x.description === "Texter"));
});

test("book_job through the factory writes the job and texts the contractor", async () => {
  const sent = [];
  const store = createStore(null);
  const calendar = stubCalendar("America/Los_Angeles");
  let step = 0;
  const chat = async () => {
    step++;
    if (step === 1) {
      const start = new Date(Date.now() + 864e5 + 16 * 3600e3).toISOString();
      const end = new Date(Date.now() + 864e5 + 17 * 3600e3).toISOString();
      return { response: JSON.stringify({ tool: "book_job", args: { start, end, description: "sink repair" } }) };
    }
    return { response: '{"say":"Locked in."}' };
  };
  const AgentCtor = makeFakeAgent(() => []);
  const c = createCopilot({
    ...deps({ notify: async (m) => sent.push(m) }),
    store,
    calendar,
    chat,
    AgentCtor,
  });
  await c.handle(msg({ body: "need a sink fixed" }));
  const config = makeFakeAgent.configs.at(-1);
  const events = [];
  for await (const e of config.factory({ input: { messages: [{ role: "user", content: "need a sink fixed" }] } })) {
    events.push(e);
  }
  assert.ok(Object.values(store.data.jobs).some((j) => j.description === "sink repair"));
  assert.ok(sent.some((m) => m.to === "+15550001111"));
  assert.ok(store.data.actions.some((a) => a.tool === "book_job" && !a.error));
});

test("same-thread messages serialize; a second run sees the first reply", async () => {
  const sent = [];
  const store = createStore(null);
  let calls = 0;
  const AgentCtor = makeFakeAgent(() => {
    calls++;
    return textEvents(`reply ${calls}`);
  });
  const c = createCopilot({ ...deps({ notify: async (m) => sent.push(m) }), store, AgentCtor });
  const [r1, r2] = await Promise.all([c.handle(msg({ body: "one" })), c.handle(msg({ body: "two" }))]);
  assert.equal(r1, "reply 1");
  assert.equal(r2, "reply 2");
  const second = makeFakeAgent.inputs.at(-1);
  assert.ok(second.messages.some((m) => m.role === "assistant" && m.content === "reply 1"));
});

test("voice turns return the reply without texting the caller", async () => {
  const sent = [];
  const AgentCtor = makeFakeAgent(() => textEvents("spoken reply"));
  const c = createCopilot({ ...deps({ notify: async (m) => sent.push(m) }), AgentCtor });
  const reply = await c.handle(msg({ channel: "voice" }));
  assert.equal(reply, "spoken reply");
  assert.equal(sent.length, 0);
});

test("bus routes sms to copilot and console to the loop", async () => {
  const copilotCalls = [];
  const loopCalls = [];
  const { server } = createBusServer({ PORT: 0 }, {
    copilot: {
      enabled: true,
      handles: (ch) => ch === "sms" || ch === "imessage",
      handle: async (m) => copilotCalls.push(m),
    },
    loop: { handle: async (m) => loopCalls.push(m), digest: async () => "", clientUpdate: async () => ({ sent: 0 }) },
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/webhooks/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const inbound = (channel, id) => ({
    channel, from: "+15551234567", body: "hi", externalId: id,
    receivedAt: new Date().toISOString(), threadKey: "+15551234567",
  });
  await post(inbound("sms", "r1"));
  await post(inbound("console", "r2"));
  await post(inbound("imessage", "r3"));
  await new Promise((r) => setTimeout(r, 50));
  server.close();
  assert.deepEqual(copilotCalls.map((m) => m.channel), ["sms", "imessage"]);
  assert.deepEqual(loopCalls.map((m) => m.channel), ["console"]);
});

test("collectRun reads async iterables too", async () => {
  async function* gen() {
    yield* textEvents("streamed");
  }
  const acc = await collectRun(gen());
  assert.equal(acc.reply, "streamed");
});
