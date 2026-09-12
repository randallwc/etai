const assert = require("node:assert/strict");
const http = require("node:http");
const { test, before, after } = require("node:test");
const { createBusServer } = require("../index.js");
const { createMessagingServer } = require("../../messaging/index.js");

let messaging, bus, calendar, bluebubbles, msgBase;
const calRequests = [];
const phoneSends = [];

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function collect(store, respondWith) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      store.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks) || "{}") });
      const [status, payload] = respondWith(req.url);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
}

async function listen(server) {
  await new Promise((r) => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(fn(), "timed out waiting");
}

before(async () => {
  calendar = collect(calRequests, () => [
    200,
    { response: "You're booked Thursday 2pm.", toolCalls: [{ name: "create_event" }], spear: null, status: "success" },
  ]);
  bluebubbles = collect(phoneSends, () => [200, { data: { guid: "bb-out-1" } }]);
  const calBase = await listen(calendar);
  const bbBase = await listen(bluebubbles);

  messaging = createMessagingServer({
    BLUEBUBBLES_URL: bbBase,
    BLUEBUBBLES_PASSWORD: "pw",
  }).server;
  msgBase = await listen(messaging);

  bus = createBusServer({
    AMBIGUOUS_BASE_URL: calBase,
    AMBIGUOUS_API_KEY: "ak_test",
    MESSAGING_URL: msgBase,
  }).server;
  const busBase = await listen(bus);

  await post(`${msgBase}/subscriptions`, { url: `${busBase}/webhooks/inbound` });
});

after(() => {
  messaging.close();
  bus.close();
  calendar.close();
  bluebubbles.close();
});

test("a text travels messaging -> bus -> calendar ai -> back out as a reply", async () => {
  const res = await post(`${msgBase}/simulate/inbound`, {
    from: "+15557654321",
    body: "can you come Thursday",
  });
  assert.equal(res.status, 202);

  await waitFor(() => calRequests.length === 1);
  assert.equal(calRequests[0].path, "/api/assistant/chat");
  assert.equal(calRequests[0].body.message, "can you come Thursday");

  await waitFor(() => phoneSends.length === 1);
  const send = phoneSends[0];
  assert.match(send.path, /^\/api\/v1\/message\/text\?password=pw$/);
  assert.equal(send.body.chatGuid, "any;-;+15557654321");
  assert.equal(send.body.message, "You're booked Thursday 2pm.");
});

test("duplicate delivery through messaging reaches the calendar once", async () => {
  const before = calRequests.length;
  const event = {
    type: "new-message",
    data: {
      guid: "BB-DUP-1",
      text: "running 20 late",
      isFromMe: false,
      handle: { address: "+15557654321" },
      dateCreated: Date.now(),
    },
  };
  await post(`${msgBase}/webhooks/bluebubbles`, event);
  await post(`${msgBase}/webhooks/bluebubbles`, event);
  await waitFor(() => calRequests.length === before + 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calRequests.length, before + 1);
});
