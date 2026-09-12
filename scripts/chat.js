const http = require("node:http");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { rmSync } = require("node:fs");

const ROOT = join(__dirname, "..");
require(join(ROOT, "shared", "env.js")).loadEnv();
const { toE164 } = require(join(ROOT, "messaging", "normalize.js"));

const stateFile = join(tmpdir(), `etai-chat-${process.pid}.json`);
const children = [];
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of children) {
    try {
      if (c.exitCode === null) c.kill("SIGKILL");
    } catch {}
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

async function waitHttp(url, pred, desc) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok && pred(await res.json())) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${desc}`);
}

async function main() {
  const mPort = await freePort();
  const aPort = await freePort();
  const msgUrl = `http://127.0.0.1:${mPort}`;
  const busUrl = `http://127.0.0.1:${aPort}`;
  const contractor = toE164(process.env.CONTRACT_PHONE ?? "15550100001");
  const client = toE164(process.env.CLIENT_PHONE ?? "15550100002");
  let me = contractor;

  const rl = readline.createInterface({ input: process.stdin });
  const prompt = () => rl.setPrompt(`${me === contractor ? "contractor" : "client"} ${me}> `);
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  rl.on("line", async (line) => {
    const text = line.trim();
    try {
      if (text === "/quit") return rl.close();
      const swap = text.match(/^\/as\s+(\S+)$/);
      if (swap) {
        const arg = swap[1].toLowerCase();
        me = arg === "contractor" ? contractor : arg === "client" ? client : toE164(arg);
      } else if (text) {
        await ready;
        await fetch(`${msgUrl}/simulate/inbound`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: me, body: text }),
        });
      }
    } catch (e) {
      console.log(`send failed: ${e.message}`);
    }
    prompt();
    rl.prompt();
  });
  rl.on("close", () => cleanup().then(() => process.exit(0)));

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
  let buf = "";
  messaging.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = line.match(/^\[sim\] -> (\S+): ([\s\S]*)$/);
      if (m) {
        const who = m[1] === contractor ? "contractor" : "client";
        process.stdout.write(`\nagent -> ${who} ${m[1]}: ${m[2]}\n`);
        prompt();
        rl.prompt();
      }
    }
  });
  messaging.stderr.on("data", (c) => process.stderr.write(c));

  const bus = spawn(process.execPath, [join(ROOT, "bus", "index.js")], {
    env: {
      ...process.env,
      PORT: String(aPort),
      MESSAGING_URL: msgUrl,
      PUBLIC_URL: busUrl,
      CONTRACT_PHONE: contractor,
      STATE_FILE: stateFile,
    },
  });
  children.push(bus);
  bus.stderr.on("data", (c) => process.stderr.write(c));

  await waitHttp(`${msgUrl}/healthz`, (h) => h.ok && h.transport === "sim", "messaging");
  await waitHttp(`${busUrl}/healthz`, (h) => h.ok && h.messaging, "bus");
  await waitHttp(`${msgUrl}/healthz`, (h) => h.subscribers >= 1, "fanout subscription");
  const health = await (await fetch(`${busUrl}/healthz`)).json();
  console.log(`chat ready -- bus stub=${health.stub} ambiguous=${health.ambiguous}`);
  console.log("type a text to send it; /as <phone|client|contractor> switches sides; /quit exits");
  resolveReady();

  prompt();
  rl.prompt();
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
  cleanup();
});
