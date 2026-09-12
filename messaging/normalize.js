const { randomUUID } = require("node:crypto");

function toE164(address) {
  const a = String(address ?? "").trim();
  if (a.startsWith("+")) return a;
  return `+${a.replace(/\D/g, "")}`;
}

function fromBlueBubbles(event) {
  if (event?.type !== "new-message") return null;
  const m = event.data ?? {};
  if (m.isFromMe) return null;
  const from = m.handle?.address ?? m.handle;
  const body = m.text;
  if (!from || !body) return null;
  const chatGuid = m.chats?.[0]?.guid;
  return {
    channel: "imessage",
    from: toE164(from),
    body,
    externalId: m.guid ?? randomUUID(),
    receivedAt: new Date(m.dateCreated ?? Date.now()).toISOString(),
    threadKey: toE164(from),
    meta: chatGuid ? { chatGuid } : undefined,
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

const GATEWAY_HOSTS = /vtext\.com|txt\.att\.net|tmomail\.net|messaging\.sprintpcs\.com|mms\.cricketwireless\.net|vmobl\.com/i;

function phoneFromEmail(addr) {
  const m = String(addr ?? "").match(/([0-9]{7,15})@/);
  if (!m || !GATEWAY_HOSTS.test(addr)) return null;
  const digits = m[1].length === 10 ? `1${m[1]}` : m[1];
  return toE164(digits);
}

function fromAmbiguousMail(event) {
  const type = event?.type ?? event?.event;
  if (type && !/email|mail|message/i.test(type)) return null;
  const d = event?.data ?? event?.mail ?? event ?? {};
  const fromAddr =
    d.from?.email ?? d.from?.address ?? d.from ?? d.sender?.email ?? d.sender;
  const from = phoneFromEmail(typeof fromAddr === "string" ? fromAddr : fromAddr?.email);
  if (!from) return null;
  const body = d.body_text ?? d.text ?? d.snippet ?? d.body ?? d.subject;
  if (!body || typeof body !== "string") return null;
  return {
    channel: "sms",
    from,
    body: body.trim(),
    externalId: `ambmail-${d.id ?? event?.id ?? randomUUID()}`,
    receivedAt: new Date(d.created_at ?? d.date ?? Date.now()).toISOString(),
    threadKey: from,
  };
}

module.exports = { fromBlueBubbles, fromSim, fromAmbiguousMail, fromMail, phoneFromEmail, replyText, toE164 };
