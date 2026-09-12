const http = require("node:http");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { createAmbiguous } = require("./ambiguous.js");
const { createCalendar } = require("./calendar.js");
const { createAi } = require("./ai.js");
const { createStore } = require("./state.js");
const { createLoop } = require("./loop.js");
const { createTts } = require("./tts.js");
const { startReminders } = require("./reminders.js");

const REQUIRED_INBOUND = ["channel", "from", "body", "externalId", "receivedAt", "threadKey"];

function createBusServer(env = process.env, overrides = {}) {
  const ambi = overrides.ambi ?? createAmbiguous(env);
  const calendar = overrides.calendar ?? createCalendar({ ambi, env });
  const ai = overrides.ai ?? createAi({ chat: (m) => ambi.assistantChat(m), env });
  const store = overrides.store ?? createStore(env.STATE_FILE ?? null);
  const messagingUrl = env.MESSAGING_URL?.replace(/\/$/, "");
  const contractorPhone = env.CONTRACT_PHONE ?? env.CONTRACTOR_PHONE;
  const tz = env.CONTRACTOR_TZ ?? "America/Los_Angeles";
  const tts = overrides.tts !== undefined ? overrides.tts : createTts({ env });

  let notify =
    overrides.notify ??
    (async ({ to, body }) => {
      if (!messagingUrl) {
        const externalId = `local-${randomUUID()}`;
        console.log(`[bus] notify -> ${to}: ${body}`);
        return { externalId };
      }
      const res = await fetch(`${messagingUrl}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, body, threadKey: to }),
        signal: AbortSignal.timeout(Number(env.SEND_TIMEOUT_MS ?? 10_000)),
      });
      if (!res.ok) throw new Error(`messaging /send -> ${res.status}`);
      console.log(`[bus] sent to ${to} via messaging (${res.status})`);
      return res.json();
    });

  const baseNotify = notify;
  notify = async (m) => {
    try {
      return await baseNotify(m);
    } catch (e) {
      await new Promise((r) => setTimeout(r, Number(env.SEND_RETRY_MS ?? 800)));
      return baseNotify(m);
    }
  };

  const loop =
    overrides.loop ??
    createLoop({ calendar, ai, store, notify, createTask: (t) => ambi.createTask(t), upsertContact: ambi.enabled ? (c) => ambi.upsertContact(c) : null, contractorPhone, tz });

  function fmtWhen(iso) {
    if (!iso) return "soon";
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    });
  }

  const KIND_LABEL = { created: "New on calendar", updated: "Calendar change", deleted: "Canceled" };

  async function notifyContractor(n) {
    const label = n.kind === "reminder" ? "Reminder" : (KIND_LABEL[n.kind] ?? `Calendar ${n.kind ?? "update"}`);
    const text = `${label}: ${n.title} at ${fmtWhen(n.startAt ?? n.triggerAt)}${n.actor ? ` (by ${n.actor})` : ""}`;
    if (!contractorPhone) return console.log(`[bus] ${text} (CONTRACT_PHONE unset)`);
    await notify({ to: contractorPhone, body: text });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }

  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  function replyJson(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json", ...CORS });
    res.end(status === 204 ? undefined : JSON.stringify(payload ?? {}));
  }

  const turns = new Map();
  function enqueue(key, fn) {
    const prev = turns.get(key) ?? Promise.resolve();
    const timed = Promise.race([
      prev.then(fn),
      new Promise((_, rej) => setTimeout(() => rej(new Error("turn timeout")), 30_000)),
    ]);
    const next = timed.catch(() => {});
    turns.set(key, next);
    next.finally(() => {
      if (turns.get(key) === next) turns.delete(key);
    });
    return timed;
  }

  function validInbound(body) {
    return (
      REQUIRED_INBOUND.every((k) => body[k] != null && body[k] !== "") &&
      /^\+[1-9]\d{6,14}$/.test(body.from) &&
      typeof body.body === "string"
    );
  }

  async function handle(req, res) {
    if (req.method === "OPTIONS") return replyJson(res, 204);
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && path === "/healthz") {
      return replyJson(res, 200, {
        ok: true,
        stub: calendar.stub ?? false,
        ambiguous: ambi.enabled,
        messaging: Boolean(messagingUrl),
        tts: Boolean(tts),
      });
    }
    if (req.method === "GET" && path === "/state") {
      return replyJson(res, 200, {
        jobs: Object.values(store.data.jobs),
        customers: Object.values(store.data.customers),
        actions: store.data.actions,
      });
    }
    if (req.method !== "POST") {
      return replyJson(res, 404, { error: { code: "invalid", message: "not found" } });
    }
    const body = await readBody(req).catch(() => null);
    if (body === null) {
      return replyJson(res, 400, { error: { code: "invalid", message: "body must be json" } });
    }
    if (path === "/webhooks/inbound") {
      if (!validInbound(body)) {
        return replyJson(res, 400, { error: { code: "invalid", message: "missing required inbound fields" } });
      }
      if (!store.dedup(body.externalId)) {
        return replyJson(res, 202, { accepted: false, duplicate: true });
      }
      replyJson(res, 202, { accepted: true });
      const beat = setTimeout(() => {
        notify({ to: body.from, body: "On it - checking the schedule now.", threadKey: body.threadKey })
          .catch(() => {});
      }, Number(env.WORKING_BEAT_MS ?? 1500));
      enqueue(body.threadKey, () => loop.handle(body))
        .catch((e) => console.error(`loop error: ${e.stack}`))
        .finally(() => clearTimeout(beat));
      return;
    }
    if (path === "/webhooks/calendar") {
      const ev = body?.data && typeof body.data === "object" ? body.data : (body ?? {});
      const kind = /^event\.(\w+)$/.exec(body?.type ?? "")?.[1] ?? body?.kind;
      const title = ev.title ?? ev.summary ?? body?.summary;
      const startAt = ev.start_at ?? ev.startAt ?? ev.start ?? ev.window?.start ?? body?.startAt ?? body?.triggerAt;
      const dedupId = typeof body?.id === "string" && body.id ? body.id : `${ev.id}:${kind}:${startAt}`;
      if (!dedupId || typeof title !== "string" || !title) {
        return replyJson(res, 400, { error: { code: "invalid", message: "id and title required" } });
      }
      if (!store.dedup(`cal:${dedupId}`)) {
        return replyJson(res, 202, { accepted: false, duplicate: true });
      }
      replyJson(res, 202, { accepted: true });
      notifyContractor({ kind, title, startAt, actor: body?.actor?.name }).catch((e) => console.error(`[bus] calendar notify failed: ${e.message}`));
      calendar.sync?.();
      return;
    }
    if (path === "/voice/turn") {
      if (!/^\+[1-9]\d{6,14}$/.test(body.from ?? "") || typeof body.body !== "string" || !body.body) {
        return replyJson(res, 400, { error: { code: "invalid", message: "need from (E.164) and body" } });
      }
      const msg = {
        channel: "voice",
        from: body.from,
        body: body.body,
        threadKey: body.threadKey ?? body.from,
        externalId: body.externalId ?? `voice-${randomUUID()}`,
        receivedAt: new Date().toISOString(),
      };
      if (!store.dedup(msg.externalId)) {
        return replyJson(res, 200, { reply: "", duplicate: true });
      }
      const reply = await enqueue(msg.threadKey, () => loop.handle(msg));
      return replyJson(res, 200, { reply: reply ?? "" });
    }
    if (path === "/tts") {
      if (!tts) {
        return replyJson(res, 503, { error: { code: "unavailable", message: "tts not installed" } });
      }
      if (typeof body.text !== "string" || !body.text) {
        return replyJson(res, 400, { error: { code: "invalid", message: "need text" } });
      }
      try {
        const audio = await tts.synthesize(body.text);
        res.writeHead(200, { "content-type": "audio/mpeg", ...CORS });
        return res.end(audio);
      } catch {
        return replyJson(res, 502, { error: { code: "upstream", message: "tts failed" } });
      }
    }
    if (path === "/internal/digest") {
      if (!contractorPhone) {
        return replyJson(res, 400, { error: { code: "invalid", message: "CONTRACT_PHONE not set" } });
      }
      const text = await loop.digest();
      await notify({ to: contractorPhone, body: text });
      return replyJson(res, 200, { sent: true, text });
    }
    if (path === "/internal/client-update") {
      const result = await loop.clientUpdate(body.phone);
      if (body.phone && !result.sent) {
        return replyJson(res, 400, { error: { code: "invalid", message: "no job for that phone" } });
      }
      return replyJson(res, 200, result);
    }
    return replyJson(res, 404, { error: { code: "invalid", message: "not found" } });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      replyJson(res, 500, { error: { code: "upstream", message: "internal error" } });
    });
  });

  async function subscribeOnce() {
    const publicUrl = env.PUBLIC_URL?.replace(/\/$/, "");
    if (!messagingUrl || !publicUrl) return false;
    const res = await fetch(`${messagingUrl}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${publicUrl}/webhooks/inbound` }),
    }).catch(() => null);
    return Boolean(res?.ok);
  }

  async function subscribe() {
    for (let i = 0; i < 5; i++) {
      if (await subscribeOnce()) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.error("subscribe failed after retries");
  }

  return { server, loop, store, notify, subscribe, subscribeOnce, calendar };
}

if (require.main === module) {
  require("../shared/env.js").loadEnv();
  const env = {
    ...process.env,
    STATE_FILE: process.env.STATE_FILE ?? join(__dirname, ".state.json"),
  };
  const port = Number(env.PORT ?? 4010);
  const { server, store, notify, subscribe, subscribeOnce, calendar } = createBusServer(env);
  server.listen(port, async () => {
    console.log(`bus listening on :${port}`);
    await subscribe();
    setInterval(subscribeOnce, 30_000).unref();
    if (calendar.sync) {
      await calendar.sync();
      setInterval(() => calendar.sync(), Number(env.CALENDAR_SYNC_MS ?? 30_000)).unref();
    }
  });
  startReminders({
    store,
    notify,
    contractorPhone: env.CONTRACT_PHONE,
    tz: env.CONTRACTOR_TZ ?? "America/Los_Angeles",
    leadMinutes: Number(env.REMINDER_LEAD_MINUTES ?? 30),
  });
}

module.exports = { createBusServer };
