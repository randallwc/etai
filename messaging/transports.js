const { randomUUID } = require("node:crypto");

function bluebubbles(env) {
  const base = env.BLUEBUBBLES_URL.replace(/\/$/, "");
  const password = env.BLUEBUBBLES_PASSWORD;
  return {
    name: "bluebubbles",
    async send({ to, body }) {
      const res = await fetch(
        `${base}/api/v1/message/text?password=${encodeURIComponent(password)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
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
  return {
    name: "ambimail",
    async send({ to, body }) {
      const digits = to.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      const res = await fetch(`${base}/api/mail/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          to: [`${digits}@${gateway}`],
          subject: "ETAi",
          body_text: body,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw Object.assign(
          new Error(`ambimail responded ${res.status}: ${data?.error ?? "unknown"}`),
          { status: 502 },
        );
      }
      return { externalId: data?.id ?? `ambimail-${randomUUID()}` };
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
