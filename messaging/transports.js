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
  return sim();
}

module.exports = { createTransport };
