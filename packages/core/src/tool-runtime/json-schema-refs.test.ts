import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inlineAcyclicLocalJsonSchemaReferences } from "./json-schema-refs.ts";

const SHARED = {
  type: "object",
  properties: {
    locationCity: { type: "string", minLength: 1, description: "城市" },
    locationDistrict: { $ref: "#/properties/locationCity", description: "区" },
    major: { type: "array", items: { $ref: "#/properties/locationCity" }, minItems: 1 },
    candidateKeywords: { $ref: "#/properties/major", description: "关键词" },
  },
  required: ["locationCity"],
} as const;

describe("inlineAcyclicLocalJsonSchemaReferences", () => {
  it("inlines local property refs, keeps sibling description, and leaves the input untouched", () => {
    const input = structuredClone(SHARED);
    const { schema, unresolved } = inlineAcyclicLocalJsonSchemaReferences(input);
    assert.deepEqual(unresolved, []);
    assert.deepEqual(schema.properties.locationDistrict, {
      type: "string",
      minLength: 1,
      description: "区",
    });
    assert.deepEqual(schema.properties.candidateKeywords, {
      type: "array",
      items: { type: "string", minLength: 1, description: "城市" },
      minItems: 1,
      description: "关键词",
    });
    assert.deepEqual(input, SHARED);
  });

  it("is idempotent", () => {
    const once = inlineAcyclicLocalJsonSchemaReferences(SHARED).schema;
    const twice = inlineAcyclicLocalJsonSchemaReferences(once).schema;
    assert.deepEqual(twice, once);
  });

  it("resolves $defs and RFC 6901 escaped pointers", () => {
    const schema = {
      type: "object",
      $defs: {
        "a/b": { type: "integer" },
        "c~d": { type: "boolean" },
        "sp ace": { type: "null" },
      },
      properties: {
        x: { $ref: "#/$defs/a~1b" },
        y: { $ref: "#/$defs/c~0d" },
        z: { $ref: "#/$defs/sp%20ace" },
      },
    };
    const { schema: out, unresolved } = inlineAcyclicLocalJsonSchemaReferences(schema);
    assert.deepEqual(unresolved, []);
    assert.deepEqual(out.properties, {
      x: { type: "integer" },
      y: { type: "boolean" },
      z: { type: "null" },
    });
  });

  it("reports recursive, external and unresolvable refs and keeps them in place", () => {
    const schema = {
      type: "object",
      $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
      properties: {
        tree: { $ref: "#/$defs/node" },
        remote: { $ref: "https://example.com/schema.json#/x" },
        missing: { $ref: "#/properties/nope" },
      },
    };
    const { schema: out, unresolved } = inlineAcyclicLocalJsonSchemaReferences(schema);
    assert.deepEqual(unresolved.map((issue) => [issue.reason, issue.ref]).sort(), [
      ["external", "https://example.com/schema.json#/x"],
      ["recursive", "#/$defs/node"],
      ["unresolvable", "#/properties/nope"],
    ]);
    assert.equal(out.properties.remote.$ref, "https://example.com/schema.json#/x");
    assert.equal(out.properties.missing.$ref, "#/properties/nope");
    assert.equal(out.properties.tree.$ref, "#/$defs/node");
  });

  it("gives up with a single limit issue when expansion would explode", () => {
    const big = { type: "string", description: "x".repeat(60_000) };
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `f${String(i)}`,
          i === 0 ? big : { $ref: "#/properties/f0" },
        ]),
      ),
    };
    const { schema: out, unresolved } = inlineAcyclicLocalJsonSchemaReferences(schema);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]?.reason, "limit");
    assert.deepEqual(out, schema);
  });
});
