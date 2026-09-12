const MESSAGING_URL = import.meta.env.VITE_MESSAGING_URL;
const DEMO_PHONE = import.meta.env.VITE_DEMO_PHONE;

/**
 * Send a text through the messaging service per the docs/PHONE.md
 * outbound contract. Never throws at the UI - check `sent`/`via`.
 * VITE_DEMO_PHONE reroutes every outbound text to the demo number.
 */
export async function sendSms({ to, body, threadKey }) {
  if (!MESSAGING_URL) return { sent: false, via: "none" };
  const dest = DEMO_PHONE || to;
  try {
    const res = await fetch(`${MESSAGING_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: dest, body, threadKey: dest }),
    });
    return res.ok
      ? { sent: true, via: "messaging" }
      : { sent: false, via: "none" };
  } catch {
    return { sent: false, via: "none" };
  }
}

export function smsHref({ to, body }) {
  return `sms:${to}?&body=${encodeURIComponent(body)}`;
}

export function etaMessage({ contractor, customer, milesText, etaText }) {
  const name = customer?.name ?? "there";
  return `Hi ${name}, ${contractor.name} here - on my way, about ${milesText} out, ETA ${etaText}.`;
}

export function lateMessage({ contractor, customer, minutes, etaText }) {
  const name = customer?.name ?? "there";
  return `Hi ${name}, ${contractor.name} here - running about ${minutes} min late, new ETA ${etaText}. Sorry for the delay.`;
}
