const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const { createTransport } = require("../transports.js");

function stubFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(url, opts);
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const ok = (data = {}) => ({
  ok: true,
  status: 200,
  json: async () => data,
});

const recipient = (call) => JSON.parse(call.opts.body).to[0];

describe("ambimail carrier gateways", () => {
  test("a mapped recipient is routed to its own gateway domain", async () => {
    const { calls, restore } = stubFetch(() => ok());
    const env = {
      AMBIG_API: "ak",
      CARRIER_GATEWAYS: '{"+15550100101":"txt.att.net"}',
      CARRIER_GATEWAY: "vtext.com",
    };
    try {
      const t = createTransport(env);
      await t.send({ to: "+15550100101", body: "hi" });
      await t.send({ to: "5550100101", body: "hi" });
    } finally {
      restore();
    }
    assert.equal(recipient(calls[0]), "5550100101@txt.att.net");
    assert.equal(recipient(calls[1]), "5550100101@txt.att.net");
  });

  test("unlisted numbers fall back to CARRIER_GATEWAY", async () => {
    const { calls, restore } = stubFetch(() => ok());
    const env = {
      AMBIG_API: "ak",
      CARRIER_GATEWAYS: '{"+15550100101":"txt.att.net"}',
      CARRIER_GATEWAY: "messaging.sprintpcs.com",
    };
    try {
      await createTransport(env).send({ to: "+15551234567", body: "hi" });
    } finally {
      restore();
    }
    assert.equal(recipient(calls[0]), "5551234567@messaging.sprintpcs.com");
  });

  test("a malformed CARRIER_GATEWAYS falls back instead of crashing", async () => {
    const { calls, restore } = stubFetch(() => ok());
    const env = {
      AMBIG_API: "ak",
      CARRIER_GATEWAYS: "not json {",
      CARRIER_GATEWAY: "txt.att.net",
    };
    try {
      const t = createTransport(env);
      await t.send({ to: "+15550100101", body: "hi" });
    } finally {
      restore();
    }
    assert.equal(recipient(calls[0]), "5550100101@txt.att.net");
  });

  test("non-object JSON maps degrade to the fallback", async () => {
    const { calls, restore } = stubFetch(() => ok());
    const env = { AMBIG_API: "ak", CARRIER_GATEWAYS: '["+15550100101"]' };
    try {
      const t = createTransport(env);
      await t.send({ to: "+15550100101", body: "hi" });
      await t.send({ to: "+15551234567", body: "hi" });
    } finally {
      restore();
    }
    assert.equal(recipient(calls[0]), "5550100101@vtext.com");
    assert.equal(recipient(calls[1]), "5551234567@vtext.com");
  });

  test("GATEWAY_MAP blasts every listed domain for a recipient", async () => {
    const { calls, restore } = stubFetch(() => ok());
    const env = {
      AMBIG_API: "ak",
      GATEWAY_MAP: "5550100100:vtext.com+txt.att.net",
      CARRIER_GATEWAY: "vtext.com",
    };
    try {
      await createTransport(env).send({ to: "+15550100100", body: "hi" });
    } finally {
      restore();
    }
    const recipients = calls.map(recipient).sort();
    assert.deepEqual(recipients, [
      "5550100100@txt.att.net",
      "5550100100@vtext.com",
    ]);
  });

  test("a malformed GATEWAY_MAP entry is ignored, not a crash", async () => {
    const { calls, restore } = stubFetch(() => ok());
    const env = {
      AMBIG_API: "ak",
      GATEWAY_MAP: "no-colon-here,5550100101:txt.att.net",
      CARRIER_GATEWAY: "vtext.com",
    };
    try {
      const t = createTransport(env);
      await t.send({ to: "+15550100101", body: "hi" });
      await t.send({ to: "+15551234567", body: "hi" });
    } finally {
      restore();
    }
    assert.equal(recipient(calls[0]), "5550100101@txt.att.net");
    assert.equal(recipient(calls[1]), "5551234567@vtext.com");
  });
});
