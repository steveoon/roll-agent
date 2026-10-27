import assert from "node:assert/strict";
import test from "node:test";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { projectAnthropicStrictToolSchema } from "./anthropic-tool-schema.ts";

test("Anthropic value-constraint projection preserves shape, metadata and original schemas", () => {
  const source: JSONSchema7 = {
    type: "object",
    properties: {
      maxItems: {
        type: "string",
        minLength: 2,
        maxLength: 10,
        pattern: "(?=x)x",
        description: "Label",
      },
      amount: {
        type: "number",
        minimum: 1,
        maximum: 10,
        exclusiveMinimum: 0,
        exclusiveMaximum: 11,
        multipleOf: 0.5,
      },
      values: {
        type: "array",
        items: { type: "integer" },
        minItems: 2,
        maxItems: 7,
        uniqueItems: true,
      },
      format: { type: "string", format: "uri-reference" },
      day: { type: "string", format: "date" },
      kind: {
        anyOf: [
          { type: "string", const: "weekly" },
          { type: "string", enum: ["daily", "interval"] },
        ],
      },
    },
    required: ["maxItems", "amount", "values", "format", "day", "kind"],
    additionalProperties: false,
    minProperties: 1,
    maxProperties: 6,
    default: { maxItems: 12, minimum: 2 },
    examples: [{ maxItems: 15, minimum: 4 }],
    definitions: { label: { type: "string", maxLength: 20 } },
  };
  const before = structuredClone(source);
  const projected = projectAnthropicStrictToolSchema(source);
  assert.deepEqual(source, before);
  assert.deepEqual(projected.required, source.required);
  assert.equal(projected.additionalProperties, false);
  assert.deepEqual(projected.default, source.default);
  assert.deepEqual(projected.examples, source.examples);
  assert.deepEqual(projected.properties?.kind, source.properties?.kind);
  assert.deepEqual(projected.properties?.day, source.properties?.day);
  assert.deepEqual(projected.properties?.maxItems, {
    type: "string",
    description: 'Label\nConstraints: minLength=2; maxLength=10; pattern="(?=x)x".',
  });
  assert.deepEqual(projected.properties?.values, {
    type: "array",
    items: { type: "integer" },
    description: "Constraints: maxItems=7; uniqueItems=true; minItems=2.",
  });
  assert.deepEqual(projected.properties?.amount, {
    type: "number",
    description:
      "Constraints: minimum=1; maximum=10; exclusiveMinimum=0; exclusiveMaximum=11; multipleOf=0.5.",
  });
  assert.deepEqual(projected.properties?.format, {
    type: "string",
    description: 'Constraints: format="uri-reference".',
  });
  assert.deepEqual(projected.definitions?.label, {
    type: "string",
    description: "Constraints: maxLength=20.",
  });
  assert.equal(projected.description, "Constraints: minProperties=1; maxProperties=6.");
  assert.deepEqual(projectAnthropicStrictToolSchema(projected), projected);
});

test("Anthropic keeps supported array minimums and branch constraints intact", () => {
  for (const minItems of [0, 1]) {
    const schema: JSONSchema7 = {
      type: "array",
      minItems,
      items: {
        allOf: [
          { type: "object", properties: { kind: { const: "x" } }, additionalProperties: false },
        ],
      },
    };
    assert.deepEqual(projectAnthropicStrictToolSchema(schema), schema);
  }
});
