const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

/**
 * Loads KEY=value pairs from a .env file into process.env without
 * overwriting variables that are already set. Returns the parsed map.
 */
function loadEnv(file = join(__dirname, "..", ".env")) {
  if (!existsSync(file)) return {};
  const vars = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[m[1]] = value;
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return vars;
}

module.exports = { loadEnv };
