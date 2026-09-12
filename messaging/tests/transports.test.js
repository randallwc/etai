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

const ok = (data = {}) => ({ ok: true, status: 200, json: async () => data });

describe("createTransport", () => {
  test("defaults to sim with no env", () => {
    assert.equal(createTransport({}).name, "sim");
  });

  test("picks ambimail from AMBIG_API or AMBIGUOUS_API_KEY", () => {
    assert.equal(createTransport({ AMBIG_API: "ak" }).name, "ambimail");
    assert.equal(createTransport({ AMBIGUOUS_API_KEY: "ak" }).name, "ambimail");
  });

  test("picks bluebubbles only with both vars, and prefers it", () => {
    assert.equal(createTransport({ BLUEBUBBLES_URL: "https://bb" }).name, "sim");
    assert.equal(
      createTransport({
        BLUEBUBBLES_URL: "https://bb",
        BLUEBUBBLES_PASSWORD: "pw",
        AMBIG_API: "ak",
      }).name,
      "bluebubbles",
    );
  });
});

describe("sim transport", () => {
  test("send logs the line and returns a sim externalId", async () => {
    const logs = [];
    const orig = console.log;
    console.log = (m) => logs.push(String(m));
    let r1, r2;
    try {
      const t = createTransport({});
      r1 = await t.send({ to: "+15551234567", body: "hello" });
      r2 = await t.send({ to: "+15551234567", body: "again" });
    } finally {
      console.log = orig;
    }
    assert.deepEqual(logs, [
      "[sim] -> +15551234567: hello",
      "[sim] -> +15551234567: again",
    ]);
    assert.match(r1.externalId, /^sim-[0-9a-f-]{36}$/);
    assert.notEqual(r1.externalId, r2.externalId);
  });
});

describe("ambimail transport", () => {
  test("posts a carrier-gateway email for the digits", async () => {
    const { calls, restore } = stubFetch(() => ok({ id: "mail-1" }));
    let result;
    try {
      result = await createTransport({ AMBIG_API: "ak_test" }).send({
        to: "+15550100100",
        body: "ETA 10:20",
      });
    } finally {
      restore();
    }
    assert.equal(result.externalId, "mail-1");
    assert.equal(calls.length, 1);
    const { url, opts } = calls[0];
    assert.equal(url, "https://app.ambiguous.ai/api/mail/send");
    assert.equal(opts.method, "POST");
    assert.equal(opts.headers["content-type"], "application/json");
    assert.equal(opts.headers.authorization, "Bearer ak_test");
    assert.deepEqual(JSON.parse(opts.body), {
      to: ["5550100100@vtext.com"],
      subject: "etAI",
      body_markdown: "ETA 10:20",
      body_text: "ETA 10:20",
    });
  });

  test("strips a leading 1 and honors CARRIER_GATEWAY and AMBIGUOUS_BASE_URL", async () => {
    const { calls, restore } = stubFetch(() => ok());
    const env = {
      AMBIGUOUS_API_KEY: "ak2",
      AMBIGUOUS_BASE_URL: "https://ambi.example.com/",
      CARRIER_GATEWAY: "txt.att.net",
    };
    try {
      const t = createTransport(env);
      await t.send({ to: "+15551234567", body: "hi" });
      await t.send({ to: "5551234567", body: "hi" });
      await t.send({ to: "+442079460123", body: "hi" });
    } finally {
      restore();
    }
    assert.equal(calls[0].url, "https://ambi.example.com/api/mail/send");
    assert.equal(JSON.parse(calls[0].opts.body).to[0], "5551234567@txt.att.net");
    assert.equal(JSON.parse(calls[1].opts.body).to[0], "5551234567@txt.att.net");
    assert.equal(JSON.parse(calls[2].opts.body).to[0], "442079460123@txt.att.net");
  });

  test("falls back to a generated externalId without an id, even on bad json", async () => {
    const { restore } = stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    }));
    try {
      const r = await createTransport({ AMBIG_API: "ak" }).send({
        to: "+15551234567",
        body: "x",
      });
      assert.match(r.externalId, /^ambimail-[0-9a-f-]{36}$/);
    } finally {
      restore();
    }
  });

  test("throws a status 502 error when the mail endpoint rejects", async () => {
    const { restore } = stubFetch(() => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "bad key" }),
    }));
    try {
      await assert.rejects(
        createTransport({ AMBIG_API: "ak" }).send({
          to: "+15551234567",
          body: "x",
        }),
        (e) => {
          assert.equal(e.status, 502);
          assert.match(e.message, /ambimail failed: .*401 bad key/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

describe("bluebubbles transport", () => {
  const env = {
    BLUEBUBBLES_URL: "https://bb.example.com/",
    BLUEBUBBLES_PASSWORD: "p w",
  };

  test("posts to message/text with chatGuid, tempGuid, and message", async () => {
    const { calls, restore } = stubFetch(() => ok({ data: { guid: "BB-SENT-1" } }));
    let result;
    try {
      result = await createTransport(env).send({
        to: "+15551234567",
        body: "on my way",
      });
    } finally {
      restore();
    }
    assert.equal(result.externalId, "BB-SENT-1");
    assert.equal(calls.length, 1);
    const { url, opts } = calls[0];
    assert.equal(
      url,
      "https://bb.example.com/api/v1/message/text?password=p%20w",
    );
    assert.equal(opts.method, "POST");
    assert.equal(opts.headers["content-type"], "application/json");
    const payload = JSON.parse(opts.body);
    assert.equal(payload.chatGuid, "any;-;+15551234567");
    assert.match(payload.tempGuid, /^etai-[0-9a-f-]{36}$/);
    assert.equal(payload.message, "on my way");
  });

  test("externalId falls back to top-level guid then a uuid", async () => {
    const bodies = [{ guid: "G2" }, {}];
    const { restore } = stubFetch(() => ok(bodies.shift()));
    try {
      const t = createTransport(env);
      assert.equal(
        (await t.send({ to: "+15551234567", body: "x" })).externalId,
        "G2",
      );
      assert.match(
        (await t.send({ to: "+15551234567", body: "x" })).externalId,
        /^[0-9a-f-]{36}$/,
      );
    } finally {
      restore();
    }
  });

  test("throws a status 502 error on a non-ok response", async () => {
    const { restore } = stubFetch(() => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    try {
      await assert.rejects(
        createTransport(env).send({ to: "+15551234567", body: "x" }),
        (e) => {
          assert.equal(e.status, 502);
          assert.match(e.message, /bluebubbles responded 500/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});
