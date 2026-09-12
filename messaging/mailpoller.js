const { fromMail } = require("./normalize");

function createMailPoller(env, accept) {
  const key = env.AMBIG_API ?? env.AMBIGUOUS_API_KEY;
  const seconds = Number(env.MAIL_POLL_SECONDS ?? 15);
  if (!key || !(seconds > 0)) return null;
  const base = (env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(
    /\/$/,
    "",
  );
  const limit = Number(env.MAIL_POLL_LIMIT ?? 20);
  const skipped = new Set();
  let timer = null;

  async function attachmentBody(id) {
    try {
      const res = await fetch(`${base}/api/mail/${id}/attachments`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (!res.ok) return null;
      const list = (await res.json()).data ?? [];
      const att =
        list.find((a) => /^text\//.test(a.mimeType ?? "")) ?? list[0];
      if (!att) return null;
      const dl = await fetch(
        `${base}/api/mail/${id}/attachments/${att.id}/download`,
        { headers: { authorization: `Bearer ${key}` } },
      );
      if (!dl.ok) return null;
      const { url } = await dl.json();
      if (!url) return null;
      const txt = await fetch(url);
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
    }).catch((e) =>
      console.error(`mailpoller: mark-read ${id} failed: ${e.message}`),
    );
  }

  async function pollOnce() {
    let data;
    try {
      const res = await fetch(
        `${base}/api/mail/inbox?limit=${limit}&unread=true`,
        { headers: { authorization: `Bearer ${key}` } },
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
    let emitted = 0;
    for (const item of data.data ?? []) {
      if (item.read) continue;
      const message = fromMail(item, env);
      if (!message) {
        if (!skipped.has(item.id)) {
          skipped.add(item.id);
          console.log(`mailpoller: skipping ${item.id}, no gateway phone`);
        }
        continue;
      }
      if (item.has_attachments && /^\(no content\)$/i.test(message.body)) {
        const real = await attachmentBody(item.id);
        if (!real) continue;
        message.body = real;
      }
      if (await accept(message)) emitted += 1;
      await markRead(item.id);
    }
    return emitted;
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
