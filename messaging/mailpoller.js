const { fromMail } = require("./normalize");

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

module.exports = { createMailPoller };
