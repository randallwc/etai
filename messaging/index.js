const http = require("node:http");
const { createTransport } = require("./transports");
const { createMailPoller } = require("./mailpoller");
const { fromBlueBubbles, fromSim, fromAmbiguousMail, toE164 } = require("./normalize");

const SEEN_CAP = 5000;
const RECENT_CAP = 200;

function createMessagingServer(env = process.env) {
  const transport = createTransport(env);
  const subscribers = new Set();
  if (env.UPSTREAM_URL) {
    subscribers.add(`${env.UPSTREAM_URL.replace(/\/$/, "")}/webhooks/inbound`);
  }
  const seen = new Set();
  const recent = [];

  async function fanout(message) {
    const results = await Promise.all(
      [...subscribers].map(async (url) => {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(message),
          });
          return res.ok;
        } catch (e) {
          console.error(`fanout to ${url} failed: ${e.message}`);
          return false;
        }
      }),
    );
    return results.filter(Boolean).length;
  }

  const inflight = new Set();
  async function accept(message) {
    if (!message) return null;
    if (seen.has(message.externalId) || inflight.has(message.externalId))
      return { message, duplicate: true };
    inflight.add(message.externalId);
    let delivered;
    try {
      delivered = await fanout(message);
    } finally {
      inflight.delete(message.externalId);
    }
    if (!delivered) return null;
    if (seen.size >= SEEN_CAP) seen.delete(seen.values().next().value);
    seen.add(message.externalId);
    recent.push(message);
    if (recent.length > RECENT_CAP) recent.shift();
    return { message, delivered };
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

  function reply(res, status, payload) {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end(status === 204 ? undefined : JSON.stringify(payload ?? {}));
  }

  async function handle(req, res) {
    if (req.method === "OPTIONS") return reply(res, 204);
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    if (req.method === "GET" && path === "/healthz") {
      return reply(res, 200, {
        ok: true,
        transport: transport.name,
        subscribers: subscribers.size,
      });
    }
    if (req.method === "GET" && path === "/messages") {
      return reply(res, 200, { messages: recent });
    }
    if (req.method !== "POST") {
      return reply(res, 404, { error: { code: "invalid", message: "not found" } });
    }
    const body = await readBody(req);
    if (path === "/send") {
      const to = body.to ? toE164(body.to) : null;
      if (!to || !/^\+[1-9]\d{6,14}$/.test(to) || typeof body.body !== "string" || !body.body) {
        return reply(res, 400, { error: { code: "invalid", message: "to must be E.164 and body non-empty" } });
      }
      try {
        const result = await transport.send({ to, body: body.body });
        return reply(res, 200, result);
      } catch (e) {
        return reply(res, e.status ?? 502, { error: { code: "upstream", message: e.message } });
      }
    }
    if (path === "/webhooks/bluebubbles") {
      const message = await accept(fromBlueBubbles(body));
      return reply(res, 202, { accepted: Boolean(message) });
    }
    if (path === "/webhooks/ambimail") {
      console.log("ambimail event:", JSON.stringify(body).slice(0, 2000));
      const message = await accept(fromAmbiguousMail(body));
      if (/^(event|calendar)\./.test(body?.type ?? "")) {
        for (const url of subscribers) {
          const target = url.replace(/\/webhooks\/inbound\/?$/, "") + "/webhooks/calendar";
          fetch(target, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }).catch((e) => console.error(`calendar event to ${target} failed: ${e.message}`));
        }
      }
      return reply(res, 202, { accepted: Boolean(message) });
    }
    if (path === "/simulate/inbound") {
      const inbound = fromSim(body);
      if (!inbound) {
        return reply(res, 400, { error: { code: "invalid", message: "from and body required" } });
      }
      const r = await accept(inbound);
      if (!r) {
        return reply(res, 503, { accepted: false, error: { code: "unavailable", message: "no subscriber accepted" } });
      }
      return reply(res, 202, { accepted: true, externalId: inbound.externalId, duplicate: Boolean(r.duplicate) });
    }
    if (path === "/subscriptions") {
      if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) {
        return reply(res, 400, { error: { code: "invalid", message: "url must be http(s)" } });
      }
      subscribers.add(body.url);
      return reply(res, 200, { subscribed: body.url, subscribers: subscribers.size });
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
  return { server, subscribers, recent, mailPoller };
}

if (require.main === module) {
  require("../shared/env.js").loadEnv();
  const port = Number(process.env.PORT ?? 4020);
  const { server } = createMessagingServer();
  server.listen(port, () => console.log(`messaging listening on :${port}`));
}

module.exports = { createMessagingServer };
