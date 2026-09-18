const http = require("node:http");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { createTransport } = require("./transports");
const { createMailPoller } = require("./mailpoller");
const { fromBlueBubbles, fromSim, fromAmbiguousMail, toE164 } = require("./normalize");
const { createAmbiguous } = require("./ambiguous.js");
const { createCalendar } = require("./calendar.js");
const { createAi } = require("./ai.js");
const { createStore } = require("./state.js");
const { createLoop } = require("./loop.js");
const { createJobPacket } = require("./packet.js");
const { createTts } = require("./tts.js");
const { startReminders } = require("./reminders.js");

const REQUIRED_INBOUND = ["channel", "from", "body", "externalId", "receivedAt", "threadKey"];
const RECENT_CAP = 200;
const MAX_BODY = 1 << 20;
const PREFIX = "etAI update: ";
const KIND_LABEL = { created: "New on calendar", updated: "Calendar change", deleted: "Canceled" };

function createService(env = process.env, overrides = {}) {
  const transport = overrides.transport ?? createTransport(env);
  const ambi = overrides.ambi ?? createAmbiguous(env);
  const calendar = overrides.calendar ?? createCalendar({ ambi, env });
  const ai = overrides.ai ?? createAi({ chat: (m) => ambi.assistantChat(m), env });
  const store = overrides.store ?? createStore(env.STATE_FILE ?? null);
  const tts = overrides.tts !== undefined ? overrides.tts : createTts({ env });
  const contractorPhone = env.CONTRACT_PHONE ?? env.CONTRACTOR_PHONE;
  const tz = env.CONTRACTOR_TZ ?? "America/Los_Angeles";

  const recent = [];
  const allowedFrom = new Set(
    (env.ALLOWED_FROM ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(toE164),
  );

  async function send({ to, body }) {
    const text = body.startsWith(PREFIX) ? body : `${PREFIX}${body}`;
    return transport.send({ to, body: text });
  }

  const notify = overrides.notify ?? send;

  const loop =
    overrides.loop ??
    createLoop({
      calendar,
      ai,
      store,
      notify,
      createTask: (t) => ambi.createTask(t),
      upsertContact: ambi.enabled ? (c) => ambi.upsertContact(c) : null,
      createPacket: ambi.enabled ? (a) => createJobPacket({ ambi, ...a }) : null,
      contractorPhone,
      tz,
    });

  const turns = new Map();
  function enqueue(key, fn) {
    const prev = turns.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => {});
    turns.set(key, tail);
    tail.finally(() => {
      if (turns.get(key) === tail) turns.delete(key);
    });
    return run;
  }

  function record(message) {
    recent.push(message);
    if (recent.length > RECENT_CAP) recent.shift();
  }

  function handleInbound(msg) {
    if (!store.dedup(msg.externalId)) return { duplicate: true };
    record(msg);
    const beat = setTimeout(() => {
      notify({ to: msg.from, body: "On it - checking the schedule now.", threadKey: msg.threadKey }).catch(() => {});
    }, Number(env.WORKING_BEAT_MS ?? 1500));
    enqueue(msg.threadKey, () => loop.handle(msg))
      .catch((e) => console.error(`loop error: ${e.stack}`))
      .finally(() => clearTimeout(beat));
    return { accepted: true };
  }

  async function accept(message) {
    if (!message) return null;
    if (allowedFrom.size && !allowedFrom.has(toE164(message.from))) {
      store.dedup(message.externalId);
      return { message, filtered: true };
    }
    return { message, ...handleInbound(message) };
  }

  function fmtWhen(iso) {
    if (!iso) return "soon";
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    });
  }

  async function notifyContractor(n) {
    const label = n.kind === "reminder" ? "Reminder" : (KIND_LABEL[n.kind] ?? `Calendar ${n.kind ?? "update"}`);
    const text = `${label}: ${n.title} at ${fmtWhen(n.startAt ?? n.triggerAt)}${n.actor ? ` (by ${n.actor})` : ""}`;
    if (!contractorPhone) return console.log(`[service] ${text} (CONTRACT_PHONE unset)`);
    await notify({ to: contractorPhone, body: text });
  }

  function handleCalendarNotification(body) {
    const ev = body?.data && typeof body.data === "object" ? body.data : (body ?? {});
    const kind = /^event\.(\w+)$/.exec(body?.type ?? "")?.[1] ?? body?.kind;
    const title = ev.title ?? ev.summary ?? body?.summary;
    const startAt = ev.start_at ?? ev.startAt ?? ev.start ?? ev.window?.start ?? body?.startAt ?? body?.triggerAt;
    const dedupId = typeof body?.id === "string" && body.id ? body.id : `${ev.id}:${kind}:${startAt}`;
    if (!dedupId || typeof title !== "string" || !title) {
      return { error: "id and title required" };
    }
    if (!store.dedup(`cal:${dedupId}`)) return { duplicate: true };
    notifyContractor({ kind, title, startAt, actor: body?.actor?.name }).catch((e) =>
      console.error(`[service] calendar notify failed: ${e.message}`),
    );
    calendar.sync?.();
    return { accepted: true };
  }

  async function pollRemoteReminders(now = new Date()) {
    if (!ambi.enabled) return { found: 0, sent: 0 };
    const windowHours = Number(env.REMINDER_WINDOW_HOURS) || 24;
    const res = await ambi.api(`/calendars/upcoming-reminders?window_hours=${windowHours}`);
    let sent = 0;
    for (const r of res.reminders ?? res.data ?? []) {
      if (!r.trigger_at || new Date(r.trigger_at) > now) continue;
      if (!store.dedup(`cal:${r.id}`)) continue;
      notifyContractor({
        kind: "reminder",
        title: r.event_title ?? "event",
        startAt: r.event_start_at ?? null,
      }).catch((e) => console.error(`[service] reminder failed: ${e.message}`));
      sent += 1;
    }
    return { found: (res.reminders ?? res.data ?? []).length, sent };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error("body too large"), { status: 413 }));
        } else {
          chunks.push(c);
        }
      });
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

  function reply(res, status, payload) {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end(status === 204 ? undefined : JSON.stringify(payload ?? {}));
  }

  function validInbound(body) {
    return (
      REQUIRED_INBOUND.every((k) => body[k] != null && body[k] !== "") &&
      /^\+[1-9]\d{6,14}$/.test(body.from) &&
      typeof body.body === "string"
    );
  }

  async function handle(req, res) {
    if (req.method === "OPTIONS") return reply(res, 204);
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && path === "/healthz") {
      const health = {
        ok: true,
        transport: transport.name,
        stub: calendar.stub ?? false,
        ambiguous: ambi.enabled,
        tts: Boolean(tts),
      };
      if (allowedFrom.size) health.allowed = allowedFrom.size;
      if (allowedFrom.size && env.CONTRACT_PHONE && !allowedFrom.has(toE164(env.CONTRACT_PHONE))) {
        health.warn = "CONTRACT_PHONE is not in ALLOWED_FROM";
      }
      return reply(res, 200, health);
    }
    if (req.method === "GET" && path === "/messages") {
      return reply(res, 200, { messages: recent });
    }
    if (req.method === "GET" && path === "/state") {
      return reply(res, 200, {
        jobs: Object.values(store.data.jobs),
        customers: Object.values(store.data.customers),
        actions: store.data.actions,
      });
    }
    if (req.method !== "POST") {
      return reply(res, 404, { error: { code: "invalid", message: "not found" } });
    }
    const body = await readBody(req).catch((e) => ({ __err: e }));
    if (body.__err) {
      return reply(res, body.__err.status ?? 400, {
        error: { code: "invalid", message: body.__err.status ? "body too large" : "malformed json" },
      });
    }
    if (path === "/send") {
      const to = body.to ? toE164(body.to) : null;
      if (!to || !/^\+[1-9]\d{6,14}$/.test(to) || typeof body.body !== "string" || !body.body) {
        return reply(res, 400, { error: { code: "invalid", message: "to must be E.164 and body non-empty" } });
      }
      try {
        return reply(res, 200, await send({ to, body: body.body }));
      } catch (e) {
        return reply(res, e.status ?? 502, { error: { code: "upstream", message: e.message } });
      }
    }
    if (path === "/webhooks/inbound") {
      if (!validInbound(body)) {
        return reply(res, 400, { error: { code: "invalid", message: "missing required inbound fields" } });
      }
      return reply(res, 202, handleInbound(body));
    }
    if (path === "/webhooks/bluebubbles") {
      const r = await accept(fromBlueBubbles(body));
      return reply(res, 202, { accepted: Boolean(r && !r.duplicate && !r.filtered) });
    }
    if (path === "/webhooks/ambimail") {
      console.log("ambimail event:", JSON.stringify(body).slice(0, 2000));
      const r = await accept(fromAmbiguousMail(body));
      if (/^(event|calendar)\./.test(body?.type ?? "")) handleCalendarNotification(body);
      return reply(res, 202, { accepted: Boolean(r && !r.duplicate && !r.filtered) });
    }
    if (path === "/webhooks/calendar") {
      const r = handleCalendarNotification(body);
      if (r.error) return reply(res, 400, { error: { code: "invalid", message: r.error } });
      return reply(res, 202, r);
    }
    if (path === "/simulate/inbound") {
      const inbound = fromSim(body);
      if (!inbound) {
        return reply(res, 400, { error: { code: "invalid", message: "from and body required" } });
      }
      const r = await accept(inbound);
      return reply(res, 202, { accepted: Boolean(r && !r.duplicate && !r.filtered), externalId: inbound.externalId });
    }
    if (path === "/voice/turn") {
      if (!/^\+[1-9]\d{6,14}$/.test(body.from ?? "") || typeof body.body !== "string" || !body.body) {
        return reply(res, 400, { error: { code: "invalid", message: "need from (E.164) and body" } });
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
        return reply(res, 200, { reply: "", duplicate: true });
      }
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("still working on it - I'll text you when it's done"), Number(env.TURN_TIMEOUT_MS ?? 30_000));
      });
      const result = await Promise.race([enqueue(msg.threadKey, () => loop.handle(msg)), timeout])
        .catch((e) => {
          console.error(`loop error: ${e.stack}`);
          return "";
        })
        .finally(() => clearTimeout(timer));
      return reply(res, 200, { reply: result ?? "" });
    }
    if (path === "/tts") {
      if (!tts) {
        return reply(res, 503, { error: { code: "unavailable", message: "tts not installed" } });
      }
      if (typeof body.text !== "string" || !body.text) {
        return reply(res, 400, { error: { code: "invalid", message: "need text" } });
      }
      try {
        const audio = await tts.synthesize(body.text);
        res.writeHead(200, { "content-type": "audio/mpeg", "access-control-allow-origin": "*" });
        return res.end(audio);
      } catch {
        return reply(res, 502, { error: { code: "upstream", message: "tts failed" } });
      }
    }
    if (path === "/internal/digest") {
      if (!contractorPhone) {
        return reply(res, 400, { error: { code: "invalid", message: "CONTRACT_PHONE not set" } });
      }
      const text = await loop.digest();
      await notify({ to: contractorPhone, body: text });
      return reply(res, 200, { sent: true, text });
    }
    if (path === "/internal/client-update") {
      const result = await loop.clientUpdate(body.phone);
      if (body.phone && !result.sent) {
        return reply(res, 400, { error: { code: "invalid", message: "no job for that phone" } });
      }
      return reply(res, 200, result);
    }
    return reply(res, 404, { error: { code: "invalid", message: "not found" } });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      reply(res, 500, { error: { code: "upstream", message: "internal error" } });
    });
  });
  const mailPoller = createMailPoller(env, accept);
  if (mailPoller) mailPoller.start();
  return { server, loop, store, notify, send, calendar, transport, accept, pollRemoteReminders, mailPoller };
}

if (require.main === module) {
  require("../shared/env.js").loadEnv();
  const env = {
    ...process.env,
    STATE_FILE: process.env.STATE_FILE ?? join(__dirname, ".state.json"),
  };
  const port = Number(env.PORT ?? 4020);
  const svc = createService(env);
  svc.server.listen(port, async () => {
    console.log(`service listening on :${port}`);
    if (svc.calendar.sync) {
      await svc.calendar.sync();
      setInterval(() => svc.calendar.sync(), Number(env.CALENDAR_SYNC_MS ?? 30_000)).unref();
    }
    setInterval(
      () => svc.pollRemoteReminders().catch((e) => console.error(`[service] reminder poll failed: ${e.message}`)),
      Number(env.REMINDER_POLL_MS ?? 60_000),
    ).unref();
  });
  startReminders({
    store: svc.store,
    notify: svc.notify,
    contractorPhone: env.CONTRACT_PHONE,
    tz: env.CONTRACTOR_TZ ?? "America/Los_Angeles",
    leadMinutes: Number(env.REMINDER_LEAD_MINUTES ?? 30),
  });
}

module.exports = { createService };
