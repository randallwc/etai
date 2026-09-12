const http = require("node:http");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { createAmbiguous } = require("./ambiguous.js");
const { createCalendar } = require("./calendar.js");
const { createAi } = require("./ai.js");
const { createStore } = require("./state.js");
const { createLoop } = require("./loop.js");
const { startReminders } = require("./reminders.js");

const REQUIRED_INBOUND = ["channel", "from", "body", "externalId", "receivedAt", "threadKey"];

function createAgentServer(env = process.env, overrides = {}) {
  const ambi = overrides.ambi ?? createAmbiguous(env);
  const calendar = overrides.calendar ?? createCalendar({ ambi, env });
  const ai = overrides.ai ?? createAi({ chat: (m) => ambi.assistantChat(m), env });
  const store = overrides.store ?? createStore(env.STATE_FILE ?? null);
  const messagingUrl = env.MESSAGING_URL?.replace(/\/$/, "");
  const contractorPhone = env.CONTRACT_PHONE ?? env.CONTRACTOR_PHONE;
  const tz = env.CONTRACTOR_TZ ?? "America/Los_Angeles";

  const notify =
    overrides.notify ??
    (async ({ to, body }) => {
      if (!messagingUrl) {
        const externalId = `local-${randomUUID()}`;
        console.log(`[notify] -> ${to}: ${body}`);
        return { externalId };
      }
      const res = await fetch(`${messagingUrl}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, body, threadKey: to }),
      });
      if (!res.ok) throw new Error(`messaging /send -> ${res.status}`);
      return res.json();
    });

  const loop =
    overrides.loop ??
    createLoop({ calendar, ai, store, notify, createTask: (t) => ambi.createTask(t), upsertContact: ambi.enabled ? (c) => ambi.upsertContact(c) : null, contractorPhone, tz });

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

  function replyJson(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload ?? {}));
  }

  function validInbound(body) {
    return (
      REQUIRED_INBOUND.every((k) => body[k] != null && body[k] !== "") &&
      /^\+[1-9]\d{6,14}$/.test(body.from) &&
      typeof body.body === "string"
    );
  }

  async function handle(req, res) {
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && path === "/healthz") {
      return replyJson(res, 200, {
        ok: true,
        stub: calendar.stub ?? false,
        ambiguous: ambi.enabled,
        messaging: Boolean(messagingUrl),
      });
    }
    if (req.method !== "POST") {
      return replyJson(res, 404, { error: { code: "invalid", message: "not found" } });
    }
    const body = await readBody(req);
    if (path === "/webhooks/inbound") {
      if (!validInbound(body)) {
        return replyJson(res, 400, { error: { code: "invalid", message: "missing required inbound fields" } });
      }
      if (!store.dedup(body.externalId)) {
        return replyJson(res, 202, { accepted: false, duplicate: true });
      }
      replyJson(res, 202, { accepted: true });
      loop.handle(body).catch((e) => console.error(`loop error: ${e.stack}`));
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
      const reply = await loop.handle(msg);
      return replyJson(res, 200, { reply: reply ?? "" });
    }
    if (path === "/internal/digest") {
      if (!contractorPhone) {
        return replyJson(res, 400, { error: { code: "invalid", message: "CONTRACT_PHONE not set" } });
      }
      const text = await loop.digest();
      await notify({ to: contractorPhone, body: text, threadKey: contractorPhone });
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

  async function subscribe() {
    const publicUrl = env.PUBLIC_URL?.replace(/\/$/, "");
    if (!messagingUrl || !publicUrl) return;
    const url = `${publicUrl}/webhooks/inbound`;
    await fetch(`${messagingUrl}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }).catch((e) => console.error(`subscribe failed: ${e.message}`));
  }

  return { server, loop, store, notify, subscribe, calendar };
}

if (require.main === module) {
  require("../shared/env.js").loadEnv();
  const env = {
    ...process.env,
    STATE_FILE: process.env.STATE_FILE ?? join(__dirname, ".state.json"),
  };
  const port = Number(env.PORT ?? 4030);
  const { server, store, notify, subscribe } = createAgentServer(env);
  server.listen(port, async () => {
    console.log(`agent listening on :${port}`);
    await subscribe();
  });
  startReminders({
    store,
    notify,
    contractorPhone: env.CONTRACT_PHONE,
    tz: env.CONTRACTOR_TZ ?? "America/Los_Angeles",
    leadMinutes: Number(env.REMINDER_LEAD_MINUTES ?? 30),
  });
}

module.exports = { createAgentServer };
