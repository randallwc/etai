const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { test } = require("node:test");

test("calendar script requires an API key", () => {
  const result = spawnSync(process.execPath, [join(__dirname, "..", "main.js")], {
    env: { ...process.env, AMBIGUOUS_API_KEY: "" },
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set AMBIGUOUS_API_KEY before running this script/);
});
