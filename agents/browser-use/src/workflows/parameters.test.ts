import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, validateParameterSchema, validateParameters } from "./parameters.ts";

test("parameter schema validates supported nested shapes and enum", () => {
  const schema = {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 2, maxLength: 5 },
      pages: { type: "array", items: { type: "integer", minimum: 1, maximum: 3 }, maxItems: 2 },
      exact: { type: "boolean", enum: [true] },
    },
  };
  assert.deepEqual(validateParameters(schema, { query: "ok", pages: [1, 2], exact: true }), {
    query: "ok",
    pages: [1, 2],
    exact: true,
  });
  for (const input of [
    {},
    { query: "x" },
    { query: "abcdef" },
    { query: "ok", extra: 1 },
    { query: "ok", pages: [1.5] },
    { query: "ok", exact: false },
  ]) {
    assert.throws(() => validateParameters(schema, input));
  }
});

test("unsupported and unsafe schemas fail closed", () => {
  for (const schema of [
    { $ref: "https://example.com/schema" },
    { type: "string", pattern: "x" },
    { type: "string", minLength: -1 },
    { type: "number", minimum: 2, maximum: 1 },
    { type: "array" },
    { type: "object", required: ["missing"] },
    { type: "string", enum: [1] },
    JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
  ]) {
    assert.throws(() => validateParameterSchema(schema));
  }
  assert.throws(() => validateParameters({ type: "number" }, Infinity));
  assert.throws(() => validateParameters({ type: "object" }, { query: undefined }));
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});
