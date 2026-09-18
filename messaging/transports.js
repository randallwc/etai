/**
 * The wire: outbound transports (ambimail or sim stdout), inbound
 * normalization, and the ambimail inbox poller. Minimum because all
 * provider-specific code lives here and nowhere else.
 */
const { randomUUID } = require("node:crypto");

function toE164(address) {
  const a = String(address ?? "").trim();
  if (a.startsWith("+")) return a;
  const digits = a.replace(/\D/g, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

function fromSim({ from, body, channel = "imessage" }) {
  if (!from || !body) return null;
  return {
    channel,
    from: toE164(from),
    body,
    externalId: `sim-${randomUUID()}`,
    receivedAt: new Date().toISOString(),
    threadKey: toE164(from),
  };
}

const GATEWAY_DOMAINS = new Set([
  "vtext.com",
  "vzwpix.com",
  "vmobl.com",
  "txt.att.net",
  "mms.att.net",
  "messaging.sprintpcs.com",
  "pm.sprint.com",
  "tmomail.net",
  "msg.fi.google.com",
  "mms.cricketwireless.net",
  "mymetropcs.com",
  "sms.myboostmobile.com",
]);

function phoneFromAddress(email, extraDomains = []) {
  const m = String(email ?? "")
    .trim()
    .toLowerCase()
    .match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m || (!GATEWAY_DOMAINS.has(m[2]) && !extraDomains.includes(m[2]))) {
    return null;
  }
  const digits = m[1].replace(/\D/g, "");
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

function replyText(body) {
  const kept = [];
  for (const line of String(body ?? "").split("\n")) {
    const t = line.trim();
    if (/^>/.test(t)) break;
    if (/^on .+wrote:$/i.test(t)) break;
    if (/^[-_]{3,}/.test(t)) break;
    if (/^sent from my /i.test(t)) break;
    if (kept.length && /^(from|sent|to|subject|date):\s/i.test(t)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function fromMail(item, env = {}) {
  if (!item?.id) return null;
  const extra = env.CARRIER_GATEWAY ? [env.CARRIER_GATEWAY.toLowerCase()] : [];
  const candidates = [
    item.from?.email,
    ...(item.reply_to ?? []).map((p) => p?.email),
  ];
  let from = null;
  for (const email of candidates) {
    from = phoneFromAddress(email, extra);
    if (from) break;
  }
  if (!from) return null;
  const body = replyText(item.body_text ?? item.preview);
  if (!body) return null;
  return {
    channel: "sms",
    from,
    body,
    externalId: `ambmail-${item.id}`,
    receivedAt: new Date(
      item.received_at ?? item.sent_at ?? Date.now(),
    ).toISOString(),
    threadKey: from,
  };
}

function ambimail(env) {
  const base = (env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
  const key = env.AMBIG_API ?? env.AMBIGUOUS_API_KEY;
  const gateway = env.CARRIER_GATEWAY ?? "vtext.com";
  const map = Object.fromEntries(
    (env.GATEWAY_MAP ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.includes(":"))
      .map((e) => {
        const [num, domains] = e.split(":");
        const key10 = num.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
        return [key10, (domains ?? "").split("+").map((d) => d.trim()).filter(Boolean)];
      })
      .filter(([num, list]) => num && list.length)
  );
  const timeout = Number(env.FETCH_TIMEOUT_MS ?? 15000);
  return {
    name: "ambimail",
    async send({ to, body }) {
      const digits = to.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      const domains = map[digits] ?? [gateway];
      const results = await Promise.allSettled(
        domains.map(async (d) => {
          let res;
          for (let attempt = 0; attempt < 2; attempt++) {
            res = await fetch(`${base}/api/mail/send`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
              },
              signal: AbortSignal.timeout(timeout),
              body: JSON.stringify({
                to: [`${digits}@${d}`],
                subject: "etAI",
                body_markdown: body,
                body_text: body,
              }),
            }).catch(() => null);
            if (res && (res.ok || res.status < 500)) break;
            if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
          }
          const data = res ? await res.json().catch(() => ({})) : {};
          if (!res?.ok) {
            throw new Error(`${d}: ${res?.status ?? "unreachable"} ${data?.error ?? "unknown"}`);
          }
          return data?.id;
        })
      );
      const ok = results.find((r) => r.status === "fulfilled");
      if (!ok) {
        throw Object.assign(
          new Error(`ambimail failed: ${results[0]?.reason?.message ?? "unknown"}`),
          { status: 502 },
        );
      }
      return { externalId: ok.value ?? `ambimail-${randomUUID()}` };
    },
  };
}

function sim() {
  return {
    name: "sim",
    async send({ to, body }) {
      const externalId = `sim-${randomUUID()}`;
      console.log(`[sim] -> ${to}: ${body}`);
      return { externalId };
    },
  };
}

function createTransport(env) {
  if (env.AMBIG_API || env.AMBIGUOUS_API_KEY) {
    return ambimail(env);
  }
  return sim();
}

const SKIP_CAP = 5000;

function createMailPoller(env, accept) {
  const key = env.AMBIG_API ?? env.AMBIGUOUS_API_KEY;
  const seconds = Number(env.MAIL_POLL_SECONDS ?? 5);
  if (!key || !(seconds > 0)) return null;
  const base = (env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(
    /\/$/,
    "",
  );
  const limit = Number(env.MAIL_POLL_LIMIT ?? 20);
  const timeout = Number(env.FETCH_TIMEOUT_MS ?? 8000);
  const skipped = new Set();
  let timer = null;
  let polling = false;

  async function attachmentBody(id) {
    try {
      const res = await fetch(`${base}/api/mail/${id}/attachments`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) return null;
      const list = (await res.json()).data ?? [];
      const att =
        list.find((a) => /^text\//.test(a.mimeType ?? "")) ?? list[0];
      if (!att) return null;
      const dl = await fetch(
        `${base}/api/mail/${id}/attachments/${att.id}/download`,
        {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(timeout),
        },
      );
      if (!dl.ok) return null;
      const { url } = await dl.json();
      if (!url) return null;
      const txt = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      return txt.ok ? (await txt.text()).trim() || null : null;
    } catch {
      return null;
    }
  }

  function markRead(id) {
    return fetch(`${base}/api/mail/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ read: true }),
      signal: AbortSignal.timeout(timeout),
    }).catch((e) =>
      console.error(`mailpoller: mark-read ${id} failed: ${e.message}`),
    );
  }

  async function pollOnce() {
    if (polling) return 0;
    polling = true;
    try {
      let data;
      try {
        const res = await fetch(
          `${base}/api/mail/inbox?limit=${limit}&unread=true`,
          {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(timeout),
          },
        );
        if (!res.ok) {
          console.error(`mailpoller: inbox responded ${res.status}`);
          return 0;
        }
        data = await res.json();
      } catch (e) {
        console.error(`mailpoller: ${e.message}`);
        return 0;
      }
      const results = await Promise.all(
        (data.data ?? []).map(async (item) => {
          if (item.read || skipped.has(item.id)) return 0;
          const message = fromMail(item, env);
          if (!message) {
            skipped.add(item.id);
            if (skipped.size > SKIP_CAP) {
              skipped.delete(skipped.values().next().value);
            }
            console.log(`mailpoller: skipping ${item.id}, no gateway phone`);
            await markRead(item.id);
            return 0;
          }
          if (item.has_attachments && /^\(no content\)$/i.test(message.body)) {
            const real = await attachmentBody(item.id);
            if (!real) return 0;
            message.body = real;
          }
          const r = await accept(message);
          if (!r) return 0;
          await markRead(item.id);
          return r.duplicate ? 0 : 1;
        })
      );
      return results.reduce((a, b) => a + b, 0);
    } finally {
      polling = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => pollOnce(), seconds * 1000);
    timer.unref?.();
    pollOnce();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, pollOnce };
}

module.exports = { createTransport, createMailPoller, fromSim, toE164 };
