const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const ROOT = join(__dirname, "..");
require(join(ROOT, "shared", "env.js")).loadEnv();
const { toE164 } = require(join(ROOT, "messaging", "normalize.js"));

const MESSAGING_URL = (process.env.MESSAGING_URL ?? "http://localhost:4020").replace(/\/$/, "");
const BUS_URL = (process.env.BUS_URL ?? "http://localhost:4010").replace(/\/$/, "");
const AMBIG_BASE = (process.env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
const AMBIG_KEY = process.env.AMBIG_API ?? process.env.AMBIGUOUS_API_KEY;
const CLIENT = toE164(process.env.CLIENT_PHONE ?? "+14253625633");
const GATEWAY = process.env.CARRIER_GATEWAY ?? "vtext.com";
const BUS_LOG = process.env.E2E_BUS_LOG ?? "/tmp/etai-bus.log";
const SKIP_RESTART = process.env.E2E_SKIP_RESTART === "1";

const HEALTH_TIMEOUT_MS = Number(process.env.E2E_HEALTH_TIMEOUT_MS ?? 15000);
const TURN_TIMEOUT_MS = Number(process.env.E2E_TURN_TIMEOUT_MS ?? 150000);
const STALL_MS = Number(process.env.E2E_STALL_MS ?? 75000);
const QUIET_MS = Number(process.env.E2E_QUIET_MS ?? 6000);
const LOG_POLL_MS = 400;
const MAIL_POLL_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const secs = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)}s`);

async function getJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const ambiGet = (path) =>
  getJson(`${AMBIG_BASE}${path}`, { headers: { authorization: `Bearer ${AMBIG_KEY}` } });

function sentLines() {
  try {
    const log = readFileSync(BUS_LOG, "utf8");
    return (log.match(new RegExp(`\\[bus\\] sent to ${CLIENT.replace("+", "\\+")}`, "g")) ?? []).length;
  } catch {
    return 0;
  }
}

async function sentMailIds() {
  const { data } = await ambiGet("/api/mail/sent?limit=25&detail=minimal");
  return new Set((data.data ?? []).map((m) => m.id));
}

async function mailDetail(id) {
  const { data } = await ambiGet(`/api/mail/${id}`);
  return data;
}

async function waitHealth(url, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { data } = await getJson(url);
      if (check(data)) return data;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`health timeout: ${url}`);
}

/**
 * Send one simulated inbound text and collect what the stack does: "sent to"
 * lines in the bus log (per-send receipts) and the real mails they produce in
 * the Ambiguous sent folder. When `match` is given, waits for a mail body
 * matching it, then drains for QUIET_MS to catch counterparty notices. Without
 * a match it runs until nothing new has arrived for STALL_MS.
 */
async function turn(text, match) {
  const baselineMails = await sentMailIds();
  const baselineSends = sentLines();
  const t0 = Date.now();
  const { status, data } = await getJson(`${MESSAGING_URL}/simulate/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: CLIENT, body: text }),
  });
  const sends = [];
  const mails = [];
  const seenMail = new Set();
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastActivity = Date.now();
  let lastMailPoll = 0;
  let matchedAt = null;
  let matched = null;
  while (Date.now() < deadline) {
    const n = sentLines();
    if (n - baselineSends > sends.length) lastActivity = Date.now();
    while (sends.length < n - baselineSends) sends.push(Date.now());
    if (Date.now() - lastMailPoll >= MAIL_POLL_MS) {
      lastMailPoll = Date.now();
      const { data: list } = await ambiGet("/api/mail/sent?limit=25").catch(() => ({ data: {} }));
      for (const m of list.data ?? []) {
        if (baselineMails.has(m.id) || seenMail.has(m.id)) continue;
        if (!(m.to ?? []).some((t) => t.email === gatewayTo)) continue;
        seenMail.add(m.id);
        const full = await mailDetail(m.id).catch(() => m);
        mails.push({ id: m.id, at: Date.now(), body: full.body_markdown ?? full.preview ?? m.preview ?? "" });
        lastActivity = Date.now();
      }
      if (!matched && match) {
        matched = mails.find((m) => match.test(m.body)) ?? null;
        if (matched) matchedAt = Date.now();
      }
    }
    if (matchedAt && Date.now() - matchedAt >= QUIET_MS) break;
    if (!matchedAt && Date.now() - lastActivity >= STALL_MS) break;
    if (!match && mails.length > 0 && mails.length >= sends.length && Date.now() - lastActivity >= QUIET_MS) break;
    await sleep(LOG_POLL_MS);
  }
  mails.sort((a, b) => a.at - b.at);
  return {
    post: { status, externalId: data.externalId ?? null, accepted: data.accepted !== false },
    t0,
    sends,
    mails,
    matched,
  };
}

const gatewayTo = `${CLIENT.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "")}@${GATEWAY}`;

let failures = 0;
const timings = [];

function show(label, r) {
  const beatIdx = r.mails.findIndex((m) => /on it - checking/i.test(m.body));
  const answerIdx = r.matched ? r.mails.indexOf(r.matched) : -1;
  const sendAt = (i) =>
    i >= 0 && r.sends.length ? r.sends[Math.min(i, r.sends.length - 1)] - r.t0 : null;
  const ack = sendAt(beatIdx);
  const answer = sendAt(answerIdx) ?? (r.sends.length ? r.sends[r.sends.length - 1] - r.t0 : null);
  timings.push({ label, ack, answer });
  console.log(
    `     sends: ${r.sends.length} [${r.sends.map((s) => secs(s - r.t0)).join(", ")}]  ` +
      `ack ${secs(ack)}  answer ${secs(answer)}` +
      (r.post.status !== 202 ? `  (inbound -> ${r.post.status})` : ""),
  );
  for (const m of r.mails) {
    console.log(`     text @${secs(m.at - r.t0)} -> ${CLIENT}: ${m.body.replace(/\n/g, " ")}`);
  }
}

async function step(label, fn) {
  process.stdout.write(`-- ${label} ... `);
  const t0 = Date.now();
  try {
    const v = await fn();
    console.log(`PASS (${secs(Date.now() - t0)})`);
    return v;
  } catch (e) {
    failures += 1;
    console.log(`FAIL (${secs(Date.now() - t0)}): ${e.message}`);
    return null;
  }
}

function expectMail(r, re, what) {
  const hit = r.mails.find((m) => re.test(m.body));
  if (!hit) {
    throw new Error(
      `no text matching ${re} (${what}); got: ${r.mails.map((m) => m.body.slice(0, 80)).join(" | ") || "nothing"}`,
    );
  }
  return hit;
}

async function busState() {
  const { data } = await getJson(`${BUS_URL}/state`);
  return data;
}

function upcomingJobs(jobs) {
  const nowMs = Date.now();
  return jobs
    .filter((j) => (j.status === "confirmed" || j.status === "en_route") && new Date(j.window.end).getTime() > nowMs)
    .sort((a, b) => new Date(a.window.start) - new Date(b.window.start));
}

function hasOffer(r) {
  return r.mails.some((m) => /which works|i have .{0,140}open|fully booked/i.test(m.body));
}

async function killService(pattern) {
  const { stdout } = await run("pgrep", ["-f", pattern]).catch(() => ({ stdout: "" }));
  const pids = stdout.split(/\s+/).filter(Boolean);
  for (const pid of pids) {
    try {
      process.kill(Number(pid));
    } catch {}
  }
  return pids.length;
}

async function main() {
  if (!AMBIG_KEY) throw new Error("AMBIG_API or AMBIGUOUS_API_KEY required");
  console.log(`messaging ${MESSAGING_URL}  bus ${BUS_URL}`);
  console.log(`phone ${CLIENT} -> ${gatewayTo} (real texts are sent)`);

  await step("messaging /healthz ambimail with subscriber", () =>
    waitHealth(`${MESSAGING_URL}/healthz`, (h) => h.ok && h.transport === "ambimail" && h.subscribers >= 1, HEALTH_TIMEOUT_MS),
  );
  await step("bus /healthz wired to messaging", () =>
    waitHealth(`${BUS_URL}/healthz`, (h) => h.ok && h.messaging, HEALTH_TIMEOUT_MS),
  );

  await step("(a) day summary -> route text", async () => {
    const r = await turn("whats my day", /route:|nothing on the calendar|nothing booked/i);
    show("day_summary", r);
    expectMail(r, /route:|nothing on the calendar|nothing booked/i, "summary");
  });

  let bookedJob = null;
  await step("(b) booking request -> slot offer", async () => {
    let r = await turn(
      "need an e2e faucet check tomorrow morning",
      /which works|i have .{0,140}open|fully booked|\?/i,
    );
    show("book", r);
    if (!hasOffer(r) && r.mails.some((m) => /\?/.test(m.body))) {
      r = await turn("tomorrow morning works, 12 demo lane", /which works|i have .{0,140}open|fully booked|\?/i);
      show("book follow-up", r);
    }
    if (!hasOffer(r)) throw new Error("no slot offer text");
  });

  await step("(c) numeric pick -> locked in + job on calendar", async () => {
    const before = await busState();
    const r = await turn("1", /locked in|already on the calendar/i);
    show("pick", r);
    expectMail(r, /locked in|already on the calendar/i, "booking confirmation");
    const after = await busState();
    const grew = after.jobs.filter((j) => !before.jobs.some((b) => b.id === j.id));
    if (!grew.length) throw new Error("no new job in /state");
    bookedJob = grew[0];
    console.log(`     job ${bookedJob.id} "${bookedJob.description}" at ${bookedJob.window.start} (${bookedJob.status})`);
  });

  await step("(d) running 20 late -> job shifted + client ETA text", async () => {
    const before = upcomingJobs((await busState()).jobs)[0];
    if (!before) throw new Error("no upcoming job to shift");
    const r = await turn("running 20 late", /new eta|shifted|active job/i);
    show("running_late", r);
    expectMail(r, /new eta|shifted/i, "late notice");
    const after = (await busState()).jobs.find((j) => j.id === before.id);
    const movedMin = (new Date(after.window.start) - new Date(before.window.start)) / 60000;
    console.log(`     job ${before.id} "${before.description}" moved +${movedMin}min`);
    if (!(movedMin > 0)) throw new Error("next job did not shift");
  });

  await step("(e) cancel -> confirm + job canceled", async () => {
    const before = await busState();
    const ref = bookedJob ? "the e2e faucet check" : "my next visit";
    let r = await turn(`cancel ${ref}`, /cancel/i);
    show("cancel", r);
    if (r.matched && /which one|few bookings|which visit/i.test(r.matched.body)) {
      r = await turn("the e2e faucet check visit", /cancel/i);
      show("cancel follow-up", r);
    }
    expectMail(r, /cancel/i, "cancel confirmation");
    const after = await busState();
    const canceled = after.jobs.filter(
      (j) => j.status === "canceled" && before.jobs.some((b) => b.id === j.id && b.status !== "canceled"),
    );
    if (!canceled.length) throw new Error("no job transitioned to canceled");
    for (const j of canceled) console.log(`     canceled ${j.id} "${j.description}"`);
  });

  if (!SKIP_RESTART) {
    await step("(f) inbound during bus restart -> queued, delivered, answered", async () => {
      const killed = await killService("node bus/index.js");
      if (!killed) throw new Error("no bus pid found");
      const t0 = Date.now();
      await sleep(400);
      const { status } = await getJson(`${MESSAGING_URL}/simulate/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: CLIENT, body: "e2e restart probe alpha" }),
      });
      const queued = status === 503;
      console.log(`\n     sim inbound during bus outage -> ${status}${queued ? " (queued)" : ""}`);
      await waitHealth(`${BUS_URL}/healthz`, (h) => h.ok, 45000);
      const delivered = await pollUntil(Date.now() + 90000, async () => {
        const { data } = await getJson(`${MESSAGING_URL}/messages`);
        return probeSeen(data.messages, "e2e restart probe alpha", t0);
      });
      if (!delivered) throw new Error("probe never reached the bus");
      console.log(`     delivered to bus after ${secs(Date.now() - t0)}`);
      const r = { mails: [] };
      const deadline = Date.now() + 90000;
      const base = await sentMailIds();
      while (Date.now() < deadline) {
        const { data: list } = await ambiGet("/api/mail/sent?limit=25");
        for (const m of list.data ?? []) {
          if (base.has(m.id) || !(m.to ?? []).some((t) => t.email === gatewayTo)) continue;
          const full = await mailDetail(m.id).catch(() => m);
          r.mails.push({ body: full.body_markdown ?? full.preview ?? "" });
        }
        if (r.mails.length) break;
        await sleep(MAIL_POLL_MS);
      }
      if (!r.mails.length) throw new Error("no reply text after redelivery");
      for (const m of r.mails) console.log(`     text -> ${CLIENT}: ${m.body.replace(/\n/g, " ")}`);
    });

    await step("(g) inbound during messaging restart", async () => {
      const killed = await killService("node messaging/index.js");
      if (!killed) throw new Error("no messaging pid found");
      const t0 = Date.now();
      await sleep(300);
      let refused = false;
      try {
        await getJson(`${MESSAGING_URL}/simulate/inbound`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: CLIENT, body: "e2e restart probe beta" }),
        });
      } catch {
        refused = true;
      }
      console.log(`\n     sim inbound while messaging down -> ${refused ? "connection refused" : "accepted"}`);
      await waitHealth(`${MESSAGING_URL}/healthz`, (h) => h.ok, 45000);
      console.log(`     messaging back after ${secs(Date.now() - t0)}`);
      const { status } = await getJson(`${MESSAGING_URL}/simulate/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: CLIENT, body: "e2e restart probe beta" }),
      });
      console.log(`     sim inbound post-respawn -> ${status}${status === 503 ? " (queued, no subscriber yet)" : ""}`);
      const delivered = await pollUntil(Date.now() + 90000, async () => {
        const { data } = await getJson(`${MESSAGING_URL}/messages`);
        return probeSeen(data.messages, "e2e restart probe beta", t0);
      });
      if (!delivered) throw new Error("probe never delivered after resubscribe");
      console.log(`     delivered to bus after ${secs(Date.now() - t0)} total`);
      return { refused };
    });
  }

  console.log("\nlatency (bar: ~2s ack, ~10s answer):");
  for (const t of timings) {
    console.log(`  ${t.label.padEnd(16)} first-out ${secs(t.ack)}  last-out ${secs(t.answer)}`);
  }
  console.log(failures ? `\ne2e-phone: FAIL (${failures} step(s))` : "\ne2e-phone: all steps passed");
  process.exitCode = failures ? 1 : 0;
}

async function pollUntil(deadline, fn) {
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(1500);
  }
  return false;
}

function probeSeen(messages, body, sinceMs) {
  const iso = new Date(sinceMs).toISOString();
  return (messages ?? []).some((m) => m.body === body && (m.receivedAt ?? "") >= iso);
}

main().catch((e) => {
  console.error(`\ne2e-phone: FAIL: ${e.message}`);
  process.exitCode = 1;
});
