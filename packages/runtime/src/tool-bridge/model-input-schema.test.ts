import assert from "node:assert/strict";
import test from "node:test";
import { asSchema, jsonSchema } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { modelToolInputSchema } from "./model-input-schema.ts";
import { buildUserInputTool } from "./user-input-tool.ts";
import { ToolRegistry } from "./naming.ts";
import { ToolExecutionCoordinator } from "./tool-execution-coordinator.ts";

function variant(kind: string) {
  return {
    type: "object" as const,
    properties: { kind: { type: "string" as const, const: kind } },
    required: ["kind"],
    additionalProperties: false,
  };
}

test("model projection converts disjoint unions in schema positions without changing metadata or source", async () => {
  const branches = [variant("set"), variant("preserve")];
  const union = { oneOf: branches };
  const source: JSONSchema7 = {
    type: "object",
    properties: {
      fields: { type: "array", items: union },
      oneOf: { type: "string" },
    },
    definitions: { action: union },
    default: union,
    examples: [union],
  };
  const before = structuredClone(source);
  let conversions = 0;
  const projected = modelToolInputSchema(
    jsonSchema(() => {
      conversions += 1;
      return source;
    }),
  );
  assert.equal(conversions, 0, "conversion stays lazy");
  const wire = await projected.jsonSchema;
  assert.deepEqual(wire, {
    ...source,
    properties: {
      fields: { type: "array", items: { anyOf: branches } },
      oneOf: { type: "string" },
    },
    definitions: { action: { anyOf: branches } },
  });
  assert.deepEqual(source, before);
  assert.equal(await projected.jsonSchema, wire);
  assert.equal(conversions, 1, "AI SDK caches the projection per tool schema");
});

test("overlapping or unproven oneOf unions retain their exclusive validation semantics", async () => {
  const left = variant("a");
  const right = variant("b");
  const schemas: JSONSchema7[] = [
    { oneOf: [left, left] },
    {
      oneOf: [
        { ...left, required: [] },
        { ...right, required: [] },
      ],
    },
    {
      oneOf: [
        { ...left, type: ["object", "null"] },
        { ...right, type: ["object", "null"] },
      ],
    },
    { oneOf: [{ type: "number" }, { type: "integer" }] },
    { oneOf: [left, true] },
    { oneOf: [{ ...left, $ref: "#/definitions/other" }, right] },
    {
      oneOf: [
        { ...left, properties: { kind: { const: "a", $ref: "#/definitions/other" } } },
        right,
      ],
    },
    { oneOf: [left, right], anyOf: [{ required: ["extra"] }] },
  ];
  for (const schema of schemas) {
    assert.deepEqual(await modelToolInputSchema(jsonSchema(schema)).jsonSchema, schema);
  }
});

test("user input model schema uses anyOf while preserving refinements and readonly parsing", async () => {
  const built = buildUserInputTool(
    {
      sessionId: "schema-fixture",
      isAvailable: () => true,
      request: async () => {
        throw new Error("must not request user input during schema validation");
      },
    },
    new ToolRegistry(),
    new ToolExecutionCoordinator(),
  );
  const tool = built.tools[built.id];
  assert.ok(tool);
  const schema = asSchema(tool.inputSchema);
  const wire = await schema.jsonSchema;
  assert.doesNotMatch(JSON.stringify(wire), /"oneOf":/u);
  assert.match(JSON.stringify(wire), /"anyOf":/u);
  assert.ok(schema.validate);
  const control = { type: "text", id: "name", label: "Name", required: true };
  const valid = await schema.validate({ controls: [control] });
  assert.ok(valid.success);
  assert.equal(Object.isFrozen(valid.value), true);
  for (const controls of [
    [control, control],
    [{ ...control, minLength: 10, maxLength: 5 }],
    [{ ...control, type: "unknown" }],
  ]) {
    assert.equal((await schema.validate({ controls })).success, false);
  }
});
