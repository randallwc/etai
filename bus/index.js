const http = require("node:http");

const SEEN_CAP = 5000;
const FALLBACK = "Sorry, I couldn't reach the calendar. Try again in a minute.";

function createBusServer(env = process.env) {
  const base = (env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
  const apiKey = env.AMBIG_API ?? env.AMBIGUOUS_API_KEY;
  const messagingUrl = env.MESSAGING_URL?.replace(/\/$/, "");
  const contractorPhone = env.CONTRACT_PHONE ?? env.CONTRACTOR_PHONE;
  const tz = env.CONTRACTOR_TZ;
  const seen = new Set();

  function dedup(externalId) {
    if (seen.has(externalId)) return false;
    if (seen.size >= SEEN_CAP) seen.delete(seen.values().next().value);
    seen.add(externalId);
    return true;
  }

  async function reply(to, body, threadKey) {
    if (!messagingUrl) return console.log(`[bus] -> ${to}: ${body}`);
    try {
      await fetch(`${messagingUrl}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, body, threadKey }),
      });
    } catch (e) {
      console.error(`[bus] send to messaging failed: ${e.message}`);
    }
  }

  async function askCalendar(text) {
    console.log(`[bus] asking calendar at ${base}`);
    const res = await fetch(`${base}/api/assistant/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "API-Version": "1",
      },
      body: JSON.stringify({ message: text, context: { audience: "agent" } }),
      signal: AbortSignal.timeout(60000),
    });
    console.log(`[bus] calendar responded ${res.status}`);
    const raw = await res.text().catch(() => "");
    console.log(`[bus] body read, ${raw.length} bytes`);
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {}
    if (!res.ok || data?.status === "error" || typeof data?.response !== "string") {
      throw new Error(`assistant chat failed (${res.status})`);
    }
    return data.response;
  }

  function fmtWhen(iso) {
    if (!iso) return "soon";
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      ...(tz ? { timeZone: tz } : {}),
    });
  }

  async function notifyContractor(n) {
    const label = n.kind === "reminder" ? "Reminder" : `Calendar ${n.kind ?? "update"}`;
    const text = `${label}: ${n.title} at ${fmtWhen(n.startAt ?? n.triggerAt)}`;
    if (!contractorPhone) return console.log(`[bus] ${text} (CONTRACT_PHONE unset)`);
    await reply(contractorPhone, text, contractorPhone);
  }

  async function forward(message) {
    console.log(`[bus] forwarding "${message.body}" from ${message.from}`);
    let answer = FALLBACK;
    if (apiKey) {
      try {
        answer = await askCalendar(message.body);
      } catch (e) {
        console.error(`[bus] calendar ai failed: ${e.message}`);
      }
    }
    console.log(`[bus] replying to ${message.from}`);
    await reply(message.from, answer, message.threadKey ?? message.from);
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

  function respond(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload ?? {}));
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");
    if (req.method === "GET" && pathname === "/healthz") {
      return respond(res, 200, {
        ok: true,
        calendar: Boolean(apiKey),
        messaging: messagingUrl ?? null,
      });
    }
    if (
      req.method !== "POST" ||
      (pathname !== "/webhooks/inbound" && pathname !== "/webhooks/calendar")
    ) {
      return respond(res, 404, { error: { code: "invalid", message: "not found" } });
    }
    const body = await readBody(req).catch(() => null);
    if (body === null) {
      return respond(res, 400, { error: { code: "invalid", message: "body must be json" } });
    }
    if (pathname === "/webhooks/calendar") {
      if (typeof body.id !== "string" || !body.id || typeof body.title !== "string" || !body.title) {
        return respond(res, 400, { error: { code: "invalid", message: "id and title required" } });
      }
      if (!dedup(`cal:${body.id}`)) {
        return respond(res, 202, { accepted: false });
      }
      respond(res, 202, { accepted: true });
      notifyContractor(body).catch((e) => console.error(`[bus] calendar notify failed: ${e.message}`));
      return;
    }
    if (
      typeof body.body !== "string" || !body.body ||
      typeof body.from !== "string" || !body.from ||
      typeof body.externalId !== "string" || !body.externalId
    ) {
      return respond(res, 400, { error: { code: "invalid", message: "from, body, externalId required" } });
    }
    if (!dedup(body.externalId)) {
      return respond(res, 202, { accepted: false });
    }
    respond(res, 202, { accepted: true });
    forward(body).catch((e) => console.error(`[bus] forward failed: ${e.message}`));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      respond(res, 500, { error: { code: "upstream", message: "internal error" } });
    });
  });
  return { server, seen };
}

if (require.main === module) {
  require("../shared/env.js").loadEnv();
  const port = Number(process.env.PORT ?? 4010);
  const { server } = createBusServer();
  server.listen(port, () => console.log(`bus listening on :${port}`));
}

module.exports = { createBusServer, FALLBACK };
