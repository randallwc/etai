const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { createAgentServer } = require("../index.js");
const { parseIntent, resolveDate } = require("../intent.js");

let server, base, sentLog;

function inbound(externalId, body, from = "+15551234567") {
  return fetch(`${base}/webhooks/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: "imessage",
      from,
      body,
      externalId,
      receivedAt: new Date().toISOString(),
      threadKey: from,
    }),
  });
}

async function waitForReplies(n) {
  for (let i = 0; i < 50; i++) {
    if (sentLog.length >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`expected ${n} replies, got ${sentLog.length}`);
}

before(async () => {
  ({ server, sentLog } = createAgentServer({}));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("intent routing", () => {
  assert.deepEqual(parseIntent("what's my day"), { type: "day" });
  assert.deepEqual(parseIntent("running 20 late"), { type: "late", minutes: 20 });
  assert.deepEqual(parseIntent("running late"), { type: "late", minutes: 15 });
  assert.deepEqual(parseIntent("cancel"), { type: "cancel" });
  assert.equal(parseIntent("yes").type, "confirm");
  assert.equal(parseIntent("no").type, "decline");
  assert.equal(parseIntent("can you come Thursday").type, "book");
  assert.equal(parseIntent("need a plumber tomorrow afternoon").type, "book");
  assert.equal(parseIntent("asdlkj").type, "unknown");
});

test("book -> confirm -> day summary loop works end to end", async () => {
  await inbound("m1", "need sprinklers fixed Thursday");
  await inbound("m2", "yes");
  await inbound("m3", "what's my day");
  await waitForReplies(3);
  assert.match(sentLog[0].body, /confirm/i);
  assert.match(sentLog[1].body, /booked/i);
  assert.match(sentLog[2].body, /sprinklers fixed thursday/i);
});

test("duplicate externalId is processed once", async () => {
  const before = sentLog.length;
  await inbound("dup-1", "what's my day");
  await inbound("dup-1", "what's my day");
  await waitForReplies(before + 1);
  assert.equal(sentLog.length, before + 1);
});

test("unknown message gets a help reply", async () => {
  const before = sentLog.length;
  await inbound("m4", "zzz");
  await waitForReplies(before + 1);
  assert.match(sentLog.at(-1).body, /book jobs/i);
});
