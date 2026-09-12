const http = require("node:http");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { rmSync } = require("node:fs");

const ROOT = join(__dirname, "..");
require(join(ROOT, "shared", "env.js")).loadEnv();
const { toE164 } = require(join(ROOT, "messaging", "normalize.js"));

const STEP_TIMEOUT_MS = Number(process.env.DEMO_STEP_TIMEOUT_MS ?? 45000);
const STEP_PAUSE_MS = Number(process.env.DEMO_STEP_PAUSE_MS ?? 800);
const CLIENT = toE164(process.env.CLIENT_PHONE ?? "15550100002");
const CONTRACTOR = toE164(process.env.CONTRACT_PHONE ?? "15550100001");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
const logs = { messaging: [], agent: [] };
const stateFile = join(tmpdir(), `etai-demo-${process.pid}.json`);
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of children) {
    if (c.exitCode === null) {
      try {
        c.kill("SIGTERM");
      } catch {}
    }
  }
  await sleep(400);
  for (const c of children) {
    if (c.exitCode === null) {
      try {
        c.kill("SIGKILL");
      } catch {}
    }
  }
  try {
    rmSync(stateFile, { force: true });
  } catch {}
}

process.on("SIGINT", () => cleanup().then(() => process.exit(130)));
process.on("SIGTERM", () => cleanup().then(() => process.exit(143)));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function watch(child, name, onLine) {
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      logs[name].push(line);
      if (logs[name].length > 200) logs[name].shift();
      onLine?.(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line) logs[name].push(line);
    }
    if (logs[name].length > 200) logs[name].splice(0, logs[name].length - 200);
  });
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function waitHttp(url, pred, desc) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await getJson(url);
      if (pred(last)) return last;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${desc}`);
}

function waitSend(outbox, pred, desc) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const i = outbox.findIndex(pred);
      if (i >= 0) {
        clearInterval(t);
        resolve(outbox.splice(i, 1)[0]);
      } else if (Date.now() > deadline) {
        clearInterval(t);
        reject(new Error(`timed out waiting for ${desc}`));
      }
    }, 150);
  });
}

async function main() {
  const mPort = await freePort();
  const aPort = await freePort();
  const msgUrl = `http://127.0.0.1:${mPort}`;
  const agentUrl = `http://127.0.0.1:${aPort}`;
  const outbox = [];

  const messaging = spawn(process.execPath, [join(ROOT, "messaging", "index.js")], {
    env: {
      ...process.env,
      PORT: String(mPort),
      AMBIG_API: "",
      AMBIGUOUS_API_KEY: "",
      BLUEBUBBLES_URL: "",
      BLUEBUBBLES_PASSWORD: "",
    },
  });
  children.push(messaging);
  watch(messaging, "messaging", (line) => {
    const m = line.match(/^\[sim\] -> (\S+): ([\s\S]*)$/);
    if (m) {
      outbox.push({ to: m[1], body: m[2] });
      console.log(`     -> ${m[1]}: ${m[2]}`);
    }
  });

  const agentEnv = {
    ...process.env,
    PORT: String(aPort),
    MESSAGING_URL: msgUrl,
    PUBLIC_URL: agentUrl,
    CONTRACT_PHONE: CONTRACTOR,
    STATE_FILE: stateFile,
  };
  const agent = spawn(process.execPath, [join(ROOT, "agent", "index.js")], { env: agentEnv });
  children.push(agent);
  watch(agent, "agent");

  console.log(`messaging :${mPort} (sim)   agent :${aPort}`);
  const mHealth = await waitHttp(`${msgUrl}/healthz`, (h) => h.ok, "messaging /healthz");
  if (mHealth.transport !== "sim") {
    throw new Error(`messaging transport is "${mHealth.transport}", expected "sim"`);
  }
  const aHealth = await waitHttp(`${agentUrl}/healthz`, (h) => h.ok && h.messaging, "agent /healthz");
  console.log(`agent up: stub=${aHealth.stub} ambiguous=${aHealth.ambiguous}`);
  await waitHttp(`${msgUrl}/healthz`, (h) => h.subscribers >= 1, "agent fanout subscription");
  console.log("agent subscribed to messaging fanout");

  async function sendInbound(from, body) {
    const who = from === CONTRACTOR ? "contractor" : "client";
    console.log(`\n>>> ${who} ${from}: ${body}`);
    await getJson(`${msgUrl}/simulate/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, body }),
    });
  }

  const steps = [
    {
      label: "booking: client requests a visit",
      from: CLIENT,
      body: "need sprinklers fixed tomorrow",
      expect: [{ to: CLIENT, re: /reply with a number/i, desc: "slot options to client" }],
    },
    {
      label: "booking: client picks a slot",
      from: CLIENT,
      body: "1",
      expect: [
        { to: CLIENT, re: /locked in/i, desc: "confirmation to client" },
        { to: CONTRACTOR, re: /new booking/i, desc: "new-booking notice to contractor" },
      ],
    },
    {
      label: "running late",
      from: CONTRACTOR,
      body: "running 20 late",
      expect: [
        { to: CLIENT, re: /running about 20 min late/i, desc: "new ETA to client" },
        { to: CONTRACTOR, re: /updated . shifted/i, desc: "shift confirmation to contractor" },
      ],
    },
    {
      label: "cancel",
      from: CLIENT,
      body: "cancel my appointment",
      expect: [
        { to: CLIENT, re: /^canceled /i, desc: "cancel confirmation to client" },
        { to: CONTRACTOR, re: /client canceled/i, desc: "cancel notice to contractor" },
      ],
    },
    {
      label: "day summary",
      from: CONTRACTOR,
      body: "what's my day",
      expect: [
        { to: CONTRACTOR, re: /route:|nothing on the calendar/i, desc: "day summary to contractor" },
      ],
    },
  ];

  for (const step of steps) {
    console.log(`\n-- ${step.label}`);
    await sendInbound(step.from, step.body);
    for (const e of step.expect) {
      await waitSend(outbox, (m) => m.to === e.to && e.re.test(m.body), e.desc);
    }
    console.log("   ok");
    await sleep(STEP_PAUSE_MS);
  }
  console.log("\ndemo complete: all four flows passed");
}

main()
  .catch((e) => {
    console.error(`\nFAIL: ${e.message}`);
    for (const name of ["messaging", "agent"]) {
      const tail = logs[name].slice(-12);
      if (tail.length) console.error(`\n--- ${name} log tail ---\n${tail.join("\n")}`);
    }
    process.exitCode = 1;
  })
  .finally(() => cleanup());
