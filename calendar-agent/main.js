const { existsSync } = require("node:fs");
const path = require("node:path");

const envFile = path.join(__dirname, "..", ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const apiKey = process.env.AMBIGUOUS_API_KEY;
const baseUrl = (process.env.AMBIGUOUS_BASE_URL ?? "https://app.ambiguous.ai").replace(/\/$/, "");
const days = Number(process.env.AMBIGUOUS_DAYS) || 7;

let requestId = 0;

function readRpcMessage(body, id) {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const parsed = JSON.parse(trimmed.slice(5));
    if (parsed.id === id) return parsed;
  }
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("{")) return null;
  const parsed = JSON.parse(trimmed);
  return parsed.id === id ? parsed : null;
}

async function rpc(method, params) {
  const id = ++requestId;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MCP ${method} request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const message = readRpcMessage(body, id);
  if (!message) {
    throw new Error(`MCP ${method} returned no matching response`);
  }
  if (message.error) {
    throw new Error(`MCP ${method} error ${message.error.code}: ${message.error.message}`);
  }
  return message.result;
}

async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = (result?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (result?.isError) {
    throw new Error(`${name} failed: ${text || "unknown tool error"}`);
  }
  if (result?.structuredContent !== undefined) {
    return result.structuredContent;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatTimeRange(event) {
  if (event.all_day) {
    return "all day     ";
  }
  const fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
  return `${fmt.format(new Date(event.start_at))} - ${fmt.format(new Date(event.end_at))}`;
}

function formatSummary(calendars, events, from, to) {
  const lines = ["Calendars:"];
  for (const cal of calendars?.data ?? []) {
    const tags = [cal.is_default ? "default" : null, cal.timezone].filter(Boolean).join(", ");
    lines.push(`- ${cal.name}${tags ? ` (${tags})` : ""}`);
  }
  lines.push("", `Events ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}:`);
  const byDay = new Map();
  for (const event of events?.data ?? []) {
    const day = new Date(event.start_at).toDateString();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  }
  const sortedDays = [...byDay.values()].sort(
    (a, b) => new Date(a[0].start_at) - new Date(b[0].start_at)
  );
  if (sortedDays.length === 0) {
    lines.push("  none");
  }
  for (const dayEvents of sortedDays) {
    lines.push(new Date(dayEvents[0].start_at).toDateString());
    for (const event of dayEvents) {
      lines.push(`  ${formatTimeRange(event)}  ${event.title ?? "(untitled)"}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  if (!apiKey) {
    throw new Error("Set AMBIGUOUS_API_KEY before running this script.");
  }

  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "calendar-agent", version: "0.1.0" }
  });

  const from = new Date();
  const to = new Date(from.getTime() + days * 86400000);

  const [calendars, events] = await Promise.all([
    callTool("list_calendars"),
    callTool("list_events", {
      start: from.toISOString(),
      end: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime"
    })
  ]);

  console.log(formatSummary(calendars, events, from, to));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, callTool, formatSummary, readRpcMessage, rpc };
