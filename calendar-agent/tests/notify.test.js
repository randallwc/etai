const assert = require("node:assert/strict");
const http = require("node:http");
const { test, before, after } = require("node:test");
const { createNotifier } = require("../notify.js");

const posts = [];
let ambi, bus, ambiBase, busBase;

const now = Date.now();
const due = {
  id: "r-due",
  event_id: "e1",
  trigger_at: new Date(now - 60000).toISOString(),
  event_title: "Sprinkler repair",
  event_start_at: new Date(now + 600000).toISOString(),
  event_end_at: new Date(now + 4200000).toISOString(),
  event_status: "confirmed",
  event_location: "412 Willow St",
  calendar_id: "c1",
};
const future = {
  id: "r-future",
  event_id: "e2",
  trigger_at: new Date(now + 3600000).toISOString(),
  event_title: "Later job",
  event_start_at: new Date(now + 7200000).toISOString(),
  event_end_at: new Date(now + 10800000).toISOString(),
  event_status: "confirmed",
  event_location: null,
  calendar_id: "c1",
};

function server(handler) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      handler(req, text ? JSON.parse(text) : {}, res);
    });
  });
}

before(async () => {
  ambi = server((req, body, res) => {
    assert.match(req.url, /^\/api\/calendars\/upcoming-reminders\?window_hours=/);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reminders: [due, future] }));
  });
  bus = server((req, body, res) => {
    posts.push({ path: req.url, body });
    res.writeHead(202, { "content-type": "application/json" });
    res.end("{}");
  });
  await Promise.all([new Promise((r) => ambi.listen(0, r)), new Promise((r) => bus.listen(0, r))]);
  ambiBase = `http://127.0.0.1:${ambi.address().port}`;
  busBase = `http://127.0.0.1:${bus.address().port}`;
});

after(() => {
  ambi.close();
  bus.close();
});

test("due reminders post to the bus once; future reminders wait", async () => {
  const notifier = createNotifier({ AMBIGUOUS_BASE_URL: ambiBase, AMBIG_API: "k", BUS_URL: busBase });
  const first = await notifier.pollOnce();
  assert.equal(first.found, 2);
  assert.equal(first.sent, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/webhooks/calendar");
  assert.equal(posts[0].body.id, "r-due");
  assert.equal(posts[0].body.kind, "reminder");
  assert.equal(posts[0].body.eventId, "e1");
  assert.equal(posts[0].body.title, "Sprinkler repair");
  assert.equal(posts[0].body.startAt, due.event_start_at);
  assert.equal(posts[0].body.triggerAt, due.trigger_at);

  const again = await notifier.pollOnce();
  assert.equal(again.sent, 0);
  assert.equal(posts.length, 1);
});

test("no BUS_URL marks reminders seen without posting", async () => {
  const before = posts.length;
  const notifier = createNotifier({ AMBIGUOUS_BASE_URL: ambiBase, AMBIG_API: "k" });
  const res = await notifier.pollOnce();
  assert.equal(res.sent, 0);
  assert.equal(posts.length, before);
  assert.ok(notifier.seen.has("r-due"));
});

test("ambiguous failure throws for the caller to log", async () => {
  const bad = server((req, body, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => bad.listen(0, r));
  const notifier = createNotifier({
    AMBIGUOUS_BASE_URL: `http://127.0.0.1:${bad.address().port}`,
    AMBIG_API: "k",
    BUS_URL: busBase,
  });
  await assert.rejects(notifier.pollOnce(), /upcoming-reminders -> 500/);
  bad.close();
});
