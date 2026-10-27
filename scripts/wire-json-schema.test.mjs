import assert from "node:assert/strict";
import { test } from "node:test";
import { expandTypeUnions } from "./wire-json-schema.mjs";

test("wire type union expansion preserves literal data and existing exclusive unions", () => {
  const literal = { type: ["string", "number"] };
  const schema = {
    type: "object",
    properties: { default: { type: ["string", "number"] } },
    $defs: { value: { type: ["string", "null"] } },
    oneOf: [{ const: literal }, { const: {} }],
    default: literal,
    examples: [literal],
    additionalProperties: false,
  };
  assert.deepEqual(expandTypeUnions(schema), {
    ...schema,
    properties: { default: { anyOf: [{ type: "string" }, { type: "number" }] } },
    $defs: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
  });
  assert.deepEqual(schema.properties.default, literal, "must not mutate source schemas");
  assert.throws(() => expandTypeUnions({ type: ["string", "number"], anyOf: [{}] }), /competing/);
});
