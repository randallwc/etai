const assert = require("node:assert/strict");
const { test, before, after, describe } = require("node:test");
const { createMessagingServer } = require("../index.js");
const { createMailPoller } = require("../mailpoller.js");
const { fromMail, replyText } = require("../normalize.js");

const mailItem = {
  id: "1b1814ca-97a3-4ba7-a56d-999a0fb80e8f",
  from: { email: "4253625633@vzwpix.com" },
  subject: "(no subject)",
  read: false,
  sent_at: "2026-09-12T20:14:07.000Z",
  body_text: "sounds good, see you then",
};

test("replyText keeps the first non-quoted block", () => {
  assert.equal(replyText("yes\n> you wrote\n> earlier"), "yes");
  assert.equal(
    replyText("on my way\nOn Tue, Sep 12, 2026 at 8:14 PM x@vtext.com wrote:\n> hi"),
    "on my way",
  );
  assert.equal(replyText("k\nSent from my iPhone"), "k");
  assert.equal(replyText("a\n\nb\n----------\nForwarded: x"), "a\n\nb");
});

test("fromMail derives E.164 from carrier gateway senders", () => {
  assert.equal(fromMail(mailItem).from, "+14253625633");
  assert.equal(
    fromMail({ ...mailItem, from: { email: "14253625633@vtext.com" } }).from,
    "+14253625633",
  );
  const viaReplyTo = fromMail({
    ...mailItem,
    from: { email: "someone@gmail.com" },
    reply_to: [{ email: "2065550199@tmomail.net" }],
  });
  assert.equal(viaReplyTo.from, "+12065550199");
});

test("fromMail returns null for non-gateway or empty mail", () => {
  assert.equal(fromMail({ ...mailItem, from: { email: "a@b.com" } }), null);
  assert.equal(fromMail({ ...mailItem, body_text: "", preview: null }), null);
  assert.equal(fromMail({ from: { email: "4253625633@vtext.com" } }), null);
});

test("fromMail emits the normalized inbound shape", () => {
  const msg = fromMail(mailItem);
  assert.deepEqual(Object.keys(msg).sort(), [
    "body",
    "channel",
    "externalId",
    "from",
    "receivedAt",
    "threadKey",
  ]);
  assert.equal(msg.channel, "sms");
  assert.equal(msg.body, "sounds good, see you then");
  assert.equal(msg.externalId, `mail-${mailItem.id}`);
  assert.equal(msg.threadKey, "+14253625633");
  assert.equal(msg.receivedAt, "2026-09-12T20:14:07.000Z");
});

test("poller is off without a key or with MAIL_POLL_SECONDS=0", () => {
  assert.equal(createMailPoller({}, async () => {}), null);
  assert.equal(
    createMailPoller({ AMBIG_API: "ak_x", MAIL_POLL_SECONDS: "0" }, async () => {}),
    null,
  );
});

describe("poller integration", () => {
  let realFetch;
  const inbox = [];
  const patched = [];

  before(() => {
    realFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      if (opts.method === "PATCH") patched.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () =>
          String(url).includes("/api/mail/inbox")
            ? { data: inbox, total: inbox.length, has_more: false }
            : {},
      };
    };
  });

  after(() => {
    global.fetch = realFetch;
  });

  test("pollOnce fans out normalized mail and marks it read", async () => {
    inbox.push({ ...mailItem });
    const { mailPoller, recent } = createMessagingServer({
      AMBIG_API: "ak_test",
      MAIL_POLL_SECONDS: "3600",
    });
    assert.ok(mailPoller);
    await mailPoller.pollOnce();
    await mailPoller.pollOnce();
    mailPoller.stop();

    assert.equal(recent.length, 1);
    assert.equal(recent[0].channel, "sms");
    assert.equal(recent[0].from, "+14253625633");
    assert.equal(recent[0].externalId, `mail-${mailItem.id}`);
    assert.ok(patched.length >= 1);
    assert.ok(patched[0].includes(`/api/mail/${mailItem.id}`));
  });

  test("pollOnce skips already-read and non-gateway mail", async () => {
    inbox.length = 0;
    inbox.push(
      { ...mailItem, id: "read-item", read: true },
      { ...mailItem, id: "human-mail", from: { email: "boss@gmail.com" } },
    );
    const emitted = [];
    const poller = createMailPoller(
      { AMBIG_API: "ak_test", MAIL_POLL_SECONDS: "3600" },
      async (m) => emitted.push(m) && m,
    );
    await poller.pollOnce();
    assert.equal(emitted.length, 0);
  });
});
