const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const {
  toE164,
  fromSim,
  fromBlueBubbles,
  fromAmbiguousMail,
  phoneFromEmail,
} = require("../normalize.js");

describe("toE164", () => {
  test("passes through +prefixed numbers after trimming", () => {
    assert.equal(toE164("+15551234567"), "+15551234567");
    assert.equal(toE164("  +15551234567  "), "+15551234567");
  });

  test("strips formatting and prefixes +1 for ten digits", () => {
    assert.equal(toE164("5551234567"), "+15551234567");
    assert.equal(toE164("(555) 123-4567"), "+15551234567");
    assert.equal(toE164("555.123.4567"), "+15551234567");
  });

  test("prefixes + for other digit runs", () => {
    assert.equal(toE164("15551234567"), "+15551234567");
    assert.equal(toE164("442071234567"), "+442071234567");
  });

  test("does not validate: garbage becomes + and +input keeps formatting", () => {
    assert.equal(toE164("not a phone"), "+");
    assert.equal(toE164(""), "+");
    assert.equal(toE164(null), "+");
    assert.equal(toE164(undefined), "+");
    assert.equal(toE164("+1 (555) 123-4567"), "+1 (555) 123-4567");
  });
});

describe("fromSim", () => {
  test("emits the normalized inboundMessage shape", () => {
    const msg = fromSim({ from: "(555) 123-4567", body: "running late" });
    assert.deepEqual(Object.keys(msg).sort(), [
      "body",
      "channel",
      "externalId",
      "from",
      "receivedAt",
      "threadKey",
    ]);
    assert.equal(msg.channel, "imessage");
    assert.equal(msg.from, "+15551234567");
    assert.equal(msg.body, "running late");
    assert.match(msg.externalId, /^sim-[0-9a-f-]{36}$/);
    assert.equal(msg.threadKey, "+15551234567");
    assert.equal(msg.receivedAt, new Date(msg.receivedAt).toISOString());
  });

  test("honors a caller-supplied channel", () => {
    assert.equal(
      fromSim({ from: "+15551234567", body: "x", channel: "voice" }).channel,
      "voice",
    );
    assert.equal(
      fromSim({ from: "+15551234567", body: "x", channel: "console" }).channel,
      "console",
    );
  });

  test("returns null without from or body", () => {
    assert.equal(fromSim({ body: "hi" }), null);
    assert.equal(fromSim({ from: "+15551234567" }), null);
    assert.equal(fromSim({ from: "", body: "hi" }), null);
    assert.equal(fromSim({ from: "+15551234567", body: "" }), null);
  });

  test("throws on a null argument", () => {
    assert.throws(() => fromSim(null), TypeError);
  });
});

const bbEvent = {
  type: "new-message",
  data: {
    guid: "BB-1",
    text: "see you at 10",
    isFromMe: false,
    handle: { address: "5551234567" },
    chats: [{ guid: "any;-;+15551234567" }],
    dateCreated: 1757700000000,
  },
};

describe("fromBlueBubbles", () => {
  test("normalizes a new-message event", () => {
    const msg = fromBlueBubbles(bbEvent);
    assert.deepEqual(Object.keys(msg).sort(), [
      "body",
      "channel",
      "externalId",
      "from",
      "meta",
      "receivedAt",
      "threadKey",
    ]);
    assert.equal(msg.channel, "imessage");
    assert.equal(msg.from, "+15551234567");
    assert.equal(msg.body, "see you at 10");
    assert.equal(msg.externalId, "BB-1");
    assert.equal(msg.receivedAt, new Date(1757700000000).toISOString());
    assert.equal(msg.threadKey, "+15551234567");
    assert.deepEqual(msg.meta, { chatGuid: "any;-;+15551234567" });
  });

  test("handle may be a bare string", () => {
    const msg = fromBlueBubbles({
      ...bbEvent,
      data: { ...bbEvent.data, guid: "BB-2", handle: "5551234567" },
    });
    assert.equal(msg.from, "+15551234567");
    assert.equal(msg.threadKey, "+15551234567");
  });

  test("meta key exists but is undefined without a chat guid", () => {
    const msg = fromBlueBubbles({
      ...bbEvent,
      data: { ...bbEvent.data, guid: "BB-3", chats: [] },
    });
    assert.ok("meta" in msg);
    assert.equal(msg.meta, undefined);
  });

  test("generates externalId and receivedAt when the event lacks them", () => {
    const msg = fromBlueBubbles({
      type: "new-message",
      data: { text: "hi", handle: { address: "+15551234567" } },
    });
    assert.match(msg.externalId, /^[0-9a-f-]{36}$/);
    assert.equal(msg.receivedAt, new Date(msg.receivedAt).toISOString());
  });

  test("returns null for other events, own sends, and missing fields", () => {
    assert.equal(fromBlueBubbles({ type: "typing-indicator", data: {} }), null);
    assert.equal(fromBlueBubbles({ type: "message-updated", data: bbEvent.data }), null);
    assert.equal(
      fromBlueBubbles({ ...bbEvent, data: { ...bbEvent.data, isFromMe: true } }),
      null,
    );
    assert.equal(
      fromBlueBubbles({ type: "new-message", data: { text: "hi" } }),
      null,
    );
    assert.equal(
      fromBlueBubbles({
        type: "new-message",
        data: { handle: { address: "+15551234567" }, text: "" },
      }),
      null,
    );
    assert.equal(fromBlueBubbles({}), null);
    assert.equal(fromBlueBubbles(null), null);
  });
});

const mailEvent = {
  type: "email.received",
  data: {
    id: "mail-1",
    from: { email: "4253625633@vtext.com" },
    body_text: "yes, 2pm works",
    created_at: "2026-09-12T20:00:00Z",
  },
};

describe("fromAmbiguousMail", () => {
  test("normalizes a gateway-sender email", () => {
    const msg = fromAmbiguousMail(mailEvent);
    assert.deepEqual(Object.keys(msg).sort(), [
      "body",
      "channel",
      "externalId",
      "from",
      "receivedAt",
      "threadKey",
    ]);
    assert.equal(msg.channel, "sms");
    assert.equal(msg.from, "+14253625633");
    assert.equal(msg.body, "yes, 2pm works");
    assert.equal(msg.externalId, "ambmail-mail-1");
    assert.equal(msg.receivedAt, "2026-09-12T20:00:00.000Z");
    assert.equal(msg.threadKey, "+14253625633");
  });

  test("accepts senders on every host in the push-path list", () => {
    for (const host of [
      "vtext.com",
      "txt.att.net",
      "tmomail.net",
      "messaging.sprintpcs.com",
      "mms.cricketwireless.net",
      "vmobl.com",
    ]) {
      const msg = fromAmbiguousMail({
        data: { id: "m", from: { email: `4253625633@${host}` }, body_text: "hi" },
      });
      assert.equal(msg.from, "+14253625633", host);
    }
  });

  test("returns null for hosts the gateway list does not include", () => {
    for (const host of [
      "pm.sprint.com",
      "mail.example.com",
      "gateway.othercarrier.net",
    ]) {
      assert.equal(
        fromAmbiguousMail({
          data: { id: "m", from: { email: `4253625633@${host}` }, body_text: "hi" },
        }),
        null,
        host,
      );
    }
  });

  test("accepts from as string, address field, or sender field", () => {
    const data = { id: "m", body_text: "hi" };
    for (const variant of [
      { from: "4253625633@vtext.com" },
      { from: { address: "4253625633@vtext.com" } },
      { sender: { email: "4253625633@vtext.com" } },
      { sender: "4253625633@vtext.com" },
    ]) {
      const msg = fromAmbiguousMail({ data: { ...data, ...variant } });
      assert.equal(msg.from, "+14253625633", JSON.stringify(variant));
    }
  });

  test("treats a bare payload or a mail key as the mail data", () => {
    const bare = fromAmbiguousMail({
      id: "m9",
      from: "4253625633@vtext.com",
      body_text: "hi",
    });
    assert.equal(bare.externalId, "ambmail-m9");
    const viaMailKey = fromAmbiguousMail({
      type: "x.email",
      mail: {
        id: "m8",
        from: { email: "4253625633@vtext.com" },
        body_text: "hi",
      },
    });
    assert.equal(viaMailKey.externalId, "ambmail-m8");
  });

  test("falls back through body_text, text, snippet, body, subject and trims", () => {
    const d = { id: "m", from: { email: "4253625633@vtext.com" } };
    assert.equal(fromAmbiguousMail({ data: { ...d, text: "t" } }).body, "t");
    assert.equal(fromAmbiguousMail({ data: { ...d, snippet: "s" } }).body, "s");
    assert.equal(fromAmbiguousMail({ data: { ...d, body: "b" } }).body, "b");
    assert.equal(fromAmbiguousMail({ data: { ...d, subject: "subj" } }).body, "subj");
    assert.equal(fromAmbiguousMail({ data: { ...d, text: "  spaced  " } }).body, "spaced");
  });

  test("filters events whose type lacks email, mail, or message", () => {
    assert.equal(fromAmbiguousMail({ type: "webhook.test", data: mailEvent.data }), null);
    assert.equal(fromAmbiguousMail({ type: "user.created", data: mailEvent.data }), null);
    assert.ok(fromAmbiguousMail({ event: "mail.received", data: mailEvent.data }));
    assert.ok(fromAmbiguousMail({ type: "new-message", data: mailEvent.data }));
  });

  test("receivedAt uses date when created_at is missing, else now", () => {
    const d = { id: "m", from: { email: "4253625633@vtext.com" }, body_text: "hi" };
    assert.equal(
      fromAmbiguousMail({ data: { ...d, date: "2026-09-12" } }).receivedAt,
      "2026-09-12T00:00:00.000Z",
    );
    const msg = fromAmbiguousMail({ data: d });
    assert.equal(msg.receivedAt, new Date(msg.receivedAt).toISOString());
  });

  test("externalId falls back to the event id then a uuid", () => {
    const d = { from: { email: "4253625633@vtext.com" }, body_text: "hi" };
    assert.equal(
      fromAmbiguousMail({ id: "evt-1", data: d }).externalId,
      "ambmail-evt-1",
    );
    assert.match(
      fromAmbiguousMail({ data: d }).externalId,
      /^ambmail-[0-9a-f-]{36}$/,
    );
  });

  test("returns null for non-gateway senders and missing bodies", () => {
    const base = { id: "m", body_text: "hi" };
    assert.equal(
      fromAmbiguousMail({
        data: { ...base, from: { email: "someone@gmail.com" } },
      }),
      null,
    );
    assert.equal(
      fromAmbiguousMail({ data: { ...base, from: { email: "123@vtext.com" } } }),
      null,
    );
    assert.equal(
      fromAmbiguousMail({
        data: { id: "m", from: { email: "4253625633@vtext.com" } },
      }),
      null,
    );
    assert.equal(
      fromAmbiguousMail({
        data: {
          id: "m",
          from: { email: "4253625633@vtext.com" },
          body: { html: "x" },
        },
      }),
      null,
    );
    assert.equal(fromAmbiguousMail(null), null);
  });
});

describe("phoneFromEmail", () => {
  test("maps gateway local parts to E.164", () => {
    assert.equal(phoneFromEmail("4253625633@vtext.com"), "+14253625633");
    assert.equal(phoneFromEmail("14253625633@vtext.com"), "+14253625633");
    assert.equal(phoneFromEmail("12065550199@tmomail.net"), "+12065550199");
  });

  test("returns null off the host list or without a digit local part", () => {
    assert.equal(phoneFromEmail("4253625633@gmail.com"), null);
    assert.equal(phoneFromEmail("abc@vtext.com"), null);
    assert.equal(phoneFromEmail("123456@vtext.com"), null);
    assert.equal(phoneFromEmail(null), null);
  });
});
