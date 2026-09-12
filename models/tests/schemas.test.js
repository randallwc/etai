const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const modelsDir = join(__dirname, "..");
const files = readdirSync(modelsDir).filter((f) => f.endsWith(".schema.json"));
const schemas = Object.fromEntries(
  files.map((f) => [f, JSON.parse(readFileSync(join(modelsDir, f), "utf8"))])
);

function validate(value, schema, root, path = "$") {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    return validate(value, root.$defs[name], root, `${path}.${name}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path}: ${JSON.stringify(value)} not in enum`];
  }
  if (schema.type === "object" || schema.properties || schema.required) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${path}: not an object`];
    }
    const errs = [];
    for (const key of schema.required ?? []) {
      if (!(key in value)) errs.push(`${path}.${key}: missing required`);
    }
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) {
      errs.push(`${path}: fewer than ${schema.minProperties} properties`);
    }
    for (const [key, val] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) errs.push(...validate(val, sub, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) {
        errs.push(`${path}.${key}: additional property`);
      }
    }
    return errs;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path}: not an array`];
    return value.flatMap((v, i) => validate(v, schema.items ?? {}, root, `${path}[${i}]`));
  }
  if (schema.type === "string" && typeof value !== "string") {
    return [`${path}: not a string`];
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    return [`${path}: not an integer`];
  }
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    return [`${path}: fails pattern ${schema.pattern}`];
  }
  if (schema.minLength && typeof value === "string" && value.length < schema.minLength) {
    return [`${path}: fails minLength ${schema.minLength}`];
  }
  if (schema.exclusiveMinimum && typeof value === "number" && value <= schema.exclusiveMinimum) {
    return [`${path}: not above ${schema.exclusiveMinimum}`];
  }
  return [];
}

test("every schema file parses and declares $schema", () => {
  assert.ok(files.length >= 2);
  for (const [file, schema] of Object.entries(schemas)) {
    assert.ok(schema.$schema, `${file} missing $schema`);
  }
});

test("required fields exist in properties", () => {
  for (const [file, schema] of Object.entries(schemas)) {
    for (const [name, def] of Object.entries(schema.$defs ?? {})) {
      for (const key of def.required ?? []) {
        assert.ok(
          key in (def.properties ?? {}),
          `${file} $defs.${name}: required '${key}' has no property definition`
        );
      }
    }
  }
});

const phone = schemas["phone-contract.schema.json"];
const calendar = schemas["calendar-contract.schema.json"];

test("inboundMessage accepts a valid phone webhook body", () => {
  const valid = {
    channel: "imessage",
    from: "+15551234567",
    body: "running 20 late",
    externalId: "guid-1",
    receivedAt: "2026-09-12T14:00:00-07:00",
    threadKey: "+15551234567",
  };
  assert.deepEqual(validate(valid, phone.$defs.inboundMessage, phone), []);
});

test("inboundMessage rejects bad channel, phone, and missing externalId", () => {
  const bad = {
    channel: "email",
    from: "5551234567",
    body: "hi",
    receivedAt: "2026-09-12T14:00:00-07:00",
    threadKey: "t",
  };
  const errs = validate(bad, phone.$defs.inboundMessage, phone);
  assert.ok(errs.some((e) => e.includes("enum")));
  assert.ok(errs.some((e) => e.includes("pattern")));
  assert.ok(errs.some((e) => e.includes("externalId")));
});

test("sendRequest and sendResponse round-trip", () => {
  assert.deepEqual(
    validate({ to: "+15551234567", body: "ETA 10:20" }, phone.$defs.sendRequest, phone),
    []
  );
  assert.deepEqual(
    validate({ externalId: "x" }, phone.$defs.sendResponse, phone),
    []
  );
});

test("calendarEvent and availabilityRequest accept valid payloads", () => {
  const event = {
    id: "evt_1",
    start: "2026-09-14T10:00:00-07:00",
    end: "2026-09-14T11:00:00-07:00",
    title: "Sprinkler repair",
    status: "confirmed",
  };
  assert.deepEqual(validate(event, calendar.$defs.calendarEvent, calendar), []);
  assert.deepEqual(
    validate(
      { date: "2026-09-14", durationMinutes: 60 },
      calendar.$defs.availabilityRequest,
      calendar
    ),
    []
  );
});

test("calendarEvent rejects unknown status and missing id", () => {
  const errs = validate(
    { id: "", start: "s", end: "e", title: "t", status: "pending" },
    calendar.$defs.calendarEvent,
    calendar
  );
  assert.ok(errs.some((e) => e.includes("enum")));
  assert.ok(errs.some((e) => e.includes("minLength")));
});

test("apiError matches the documented error envelope", () => {
  assert.deepEqual(
    validate(
      { error: { code: "conflict", message: "overlaps evt_2" } },
      calendar.$defs.apiError,
      calendar
    ),
    []
  );
});
