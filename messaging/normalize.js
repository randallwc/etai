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

module.exports = { fromBlueBubbles, fromSim, toE164 };
