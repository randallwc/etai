const { randomUUID } = require("node:crypto");

function bluebubbles(env) {
  const base = env.BLUEBUBBLES_URL.replace(/\/$/, "");
  const password = env.BLUEBUBBLES_PASSWORD;
  const timeout = Number(env.FETCH_TIMEOUT_MS ?? 8000);
  return {
    name: "bluebubbles",
    async send({ to, body }) {
      const res = await fetch(
        `${base}/api/v1/message/text?password=${encodeURIComponent(password)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(timeout),
          body: JSON.stringify({
            chatGuid: `any;-;${to}`,
            tempGuid: `etai-${randomUUID()}`,
            message: body,
          }),
        },
      );
      if (!res.ok) {
        throw Object.assign(new Error(`bluebubbles responded ${res.status}`), {
          status: 502,
        });
      }
      const data = await res.json().catch(() => ({}));
      return { externalId: data?.data?.guid ?? data?.guid ?? randomUUID() };
    },
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
      .filter(Boolean)
      .map((e) => {
        const [num, domains] = e.split(":");
        const key10 = num.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
        return [key10, domains.split("+").map((d) => d.trim()).filter(Boolean)];
      })
  );
  const timeout = Number(env.FETCH_TIMEOUT_MS ?? 8000);
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
                subject: "ETAi",
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
  if (env.BLUEBUBBLES_URL && env.BLUEBUBBLES_PASSWORD) {
    return bluebubbles(env);
  }
  if (env.AMBIG_API || env.AMBIGUOUS_API_KEY) {
    return ambimail(env);
  }
  return sim();
}

module.exports = { createTransport };
