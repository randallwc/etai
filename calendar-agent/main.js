const { existsSync } = require("node:fs");
const path = require("node:path");

const envFile = path.join(__dirname, "..", ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const apiKey = process.env.AMBIGUOUS_API_KEY;
const baseUrl = (process.env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
const message = process.env.AMBIGUOUS_TASK ?? "List my calendars and summarize my events for the next seven days. Do not create, update, cancel, decline, or delete anything.";

async function main() {
  if (!apiKey) {
    throw new Error("Set AMBIGUOUS_API_KEY before running this script.");
  }

  const response = await fetch(`${baseUrl}/api/assistant/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "API-Version": "1"
    },
    body: JSON.stringify({
      message,
      context: {
        audience: "agent"
      }
    })
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Ambiguous Assistant request failed (${response.status}): ${JSON.stringify(body)}`);
  }

  console.log(body.response);
  console.log("\nTool calls:");
  console.dir(body.toolCalls, { depth: null });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
