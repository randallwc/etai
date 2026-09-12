const { join } = require("node:path");

const ROOT = join(__dirname, "..");
require(join(ROOT, "shared", "env.js")).loadEnv();
const { toE164 } = require(join(ROOT, "messaging", "normalize.js"));

const MESSAGING_URL = (process.env.MESSAGING_URL ?? "http://localhost:4020").replace(/\/$/, "");
const BUS_URL = (process.env.BUS_URL ?? "http://localhost:4010").replace(/\/$/, "");
const AMBIG_BASE = (process.env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
const AMBIG_KEY = process.env.AMBIG_API ?? process.env.AMBIGUOUS_API_KEY;
const CLIENT = toE164(process.env.CLIENT_PHONE ?? "+14253625633");
const GATEWAY = process.env.CARRIER_GATEWAY ?? "vtext.com";
const PREFIX = "etAI update: ";
const BODY = process.env.E2E_BODY ?? "need a sprinkler valve fixed tomorrow morning";

const HEALTH_TIMEOUT_MS = Number(process.env.E2E_HEALTH_TIMEOUT_MS ?? 15000);
const INBOUND_TIMEOUT_MS = Number(process.env.E2E_INBOUND_TIMEOUT_MS ?? 15000);
const MAIL_TIMEOUT_MS = Number(process.env.E2E_MAIL_TIMEOUT_MS ?? 150000);
const POLL_MS = Number(process.env.E2E_POLL_MS ?? 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const ambiGet = (path) =>
  getJson(`${AMBIG_BASE}${path}`, { headers: { authorization: `Bearer ${AMBIG_KEY}` } });

async function poll(desc, timeoutMs, tryFn) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await tryFn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${desc}${lastErr ? ` (last: ${lastErr.message})` : ""}`);
}

let failures = 0;

async function step(label, fn) {
  process.stdout.write(`-- ${label} ... `);
  const t0 = Date.now();
  try {
    const v = await fn();
    console.log(`PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return v;
  } catch (e) {
    failures += 1;
    console.log(`FAIL (${((Date.now() - t0) / 1000).toFixed(1)}s): ${e.message}`);
    return null;
  }
}

async function main() {
  if (!AMBIG_KEY) throw new Error("AMBIG_API or AMBIGUOUS_API_KEY required");
  const digits = CLIENT.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const gatewayTo = `${digits}@${GATEWAY}`;
  console.log(`messaging ${MESSAGING_URL}  bus ${BUS_URL}`);
  console.log(`client ${CLIENT} -> ${gatewayTo}`);

  await step("messaging /healthz is ambimail with a subscriber", () =>
    poll("messaging health", HEALTH_TIMEOUT_MS, async () => {
      const h = await getJson(`${MESSAGING_URL}/healthz`);
      return h.ok && h.transport === "ambimail" && h.subscribers >= 1 ? h : null;
    }),
  );

  await step("bus /healthz is up and wired to messaging", () =>
    poll("bus health", HEALTH_TIMEOUT_MS, async () => {
      const h = await getJson(`${BUS_URL}/healthz`);
      return h.ok && h.messaging ? h : null;
    }),
  );

  const baseline = await step("snapshot Ambiguous sent folder", async () => {
    const data = await ambiGet("/api/mail/sent?limit=25&detail=minimal");
    return new Set((data.data ?? []).map((m) => m.id));
  });

  const inbound = await step(`inbound from client: "${BODY}"`, async () => {
    const r = await getJson(`${MESSAGING_URL}/simulate/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: CLIENT, body: BODY }),
    });
    if (!r.externalId) throw new Error("simulate/inbound returned no externalId");
    return r;
  });

  if (inbound) {
    await step("inbound visible in messaging /messages", () =>
      poll("inbound in /messages", INBOUND_TIMEOUT_MS, async () => {
        const { messages } = await getJson(`${MESSAGING_URL}/messages`);
        return messages.find((m) => m.externalId === inbound.externalId) ?? null;
      }),
    );
  }

  const mail = await step("agent reply lands in Ambiguous sent mail", async () => {
    if (!baseline) throw new Error("no baseline snapshot");
    return poll(`sent mail to ${gatewayTo}`, MAIL_TIMEOUT_MS, async () => {
      const data = await ambiGet("/api/mail/sent?limit=25");
      return (
        (data.data ?? []).find(
          (m) =>
            !baseline.has(m.id) &&
            (m.to ?? []).some((t) => t.email === gatewayTo),
        ) ?? null
      );
    });
  });

  if (mail) {
    await step(`outbound body carries "${PREFIX}" prefix`, async () => {
      const full = await ambiGet(`/api/mail/${mail.id}`);
      const body = full.body_markdown ?? full.preview ?? "";
      console.log(`\n     -> ${gatewayTo}: ${body}`);
      if (!body.startsWith(PREFIX)) {
        throw new Error(`body lacks prefix: ${body.slice(0, 120)}`);
      }
      return body;
    });
  }

  console.log(failures ? `\ne2e-phone: FAIL (${failures} step(s))` : "\ne2e-phone: all steps passed");
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(`\ne2e-phone: FAIL: ${e.message}`);
  process.exitCode = 1;
});
