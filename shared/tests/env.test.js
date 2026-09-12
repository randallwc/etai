const assert = require("node:assert/strict");
const { writeFileSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { loadEnv } = require("../env.js");

function tempEnv(contents) {
  const dir = mkdtempSync(join(tmpdir(), "etai-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, contents);
  return file;
}

test("loadEnv parses pairs, skips comments, strips quotes", () => {
  const file = tempEnv(
    'A=1\n# comment\nB="quoted value"\nC=\nnot a line\n'
  );
  const vars = loadEnv(file);
  assert.equal(vars.A, "1");
  assert.equal(vars.B, "quoted value");
  assert.equal(vars.C, "");
  assert.equal(process.env.A, "1");
  delete process.env.A;
  delete process.env.B;
  delete process.env.C;
});

test("loadEnv does not override existing process.env", () => {
  process.env.PREEXISTING = "real";
  const file = tempEnv("PREEXISTING=fake\n");
  const vars = loadEnv(file);
  assert.equal(vars.PREEXISTING, "fake");
  assert.equal(process.env.PREEXISTING, "real");
  delete process.env.PREEXISTING;
});

test("loadEnv returns empty map when the file is absent", () => {
  assert.deepEqual(loadEnv("/nonexistent/.env"), {});
});
