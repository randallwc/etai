const http = require("node:http");
const { createTransport } = require("./transports");
const { fromBlueBubbles, fromSim, toE164 } = require("./normalize");

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

  function dedup(externalId) {
    if (seen.has(externalId)) return false;
    if (seen.size >= SEEN_CAP) seen.delete(seen.values().next().value);
    seen.add(externalId);
    return true;
  }

  async function fanout(message) {
    for (const url of subscribers) {
      try {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
        });
      } catch (e) {
        console.error(`fanout to ${url} failed: ${e.message}`);
      }
    }
  }

  async function accept(message) {
    if (!message || !dedup(message.externalId)) return null;
    recent.push(message);
    if (recent.length > RECENT_CAP) recent.shift();
    await fanout(message);
    return message;
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
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload ?? {}));
  }

  async function handle(req, res) {
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
    if (path === "/simulate/inbound") {
      const message = await accept(fromSim(body));
      if (!message) {
        return reply(res, 400, { error: { code: "invalid", message: "from and body required" } });
      }
      return reply(res, 202, { externalId: message.externalId });
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
  return { server, subscribers, recent };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 4020);
  const { server } = createMessagingServer();
  server.listen(port, () => console.log(`messaging listening on :${port}`));
}

module.exports = { createMessagingServer };
