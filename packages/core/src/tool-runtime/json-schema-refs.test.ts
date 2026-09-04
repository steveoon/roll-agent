import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inlineAcyclicLocalJsonSchemaReferences,
  isRootDefinitionReference,
} from "./json-schema-refs.ts";

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

  it("merges only annotation siblings and refuses to inline refs carrying validation keywords", () => {
    const schema = {
      type: "object",
      definitions: { text: { type: "string" } },
      properties: {
        annotated: { $ref: "#/definitions/text", description: "备注", title: "标题" },
        constrained: { $ref: "#/definitions/text", type: "number" },
      },
    };
    const { schema: out, unresolved } = inlineAcyclicLocalJsonSchemaReferences(schema);
    assert.deepEqual(out.properties.annotated, {
      type: "string",
      description: "备注",
      title: "标题",
    });
    assert.deepEqual(out.properties.constrained, { $ref: "#/definitions/text", type: "number" });
    assert.deepEqual(unresolved, [
      { path: "/properties/constrained", ref: "#/definitions/text", reason: "sibling-keywords" },
    ]);
  });

  it("inlines boolean schema targets", () => {
    const schema = {
      type: "object",
      $defs: { anything: true, nothing: false },
      properties: {
        a: { $ref: "#/$defs/anything", description: "任意" },
        b: { $ref: "#/$defs/nothing" },
      },
    };
    const { schema: out, unresolved } = inlineAcyclicLocalJsonSchemaReferences(schema);
    assert.deepEqual(unresolved, []);
    assert.deepEqual(out.properties.a, { description: "任意" });
    assert.deepEqual(out.properties.b, { not: {} });
  });

  it("only accepts canonical array indexes in pointers", () => {
    const schema = {
      type: "object",
      properties: {
        v: { anyOf: [{ type: "string" }, { type: "number" }] },
        ok: { $ref: "#/properties/v/anyOf/1" },
        padded: { $ref: "#/properties/v/anyOf/01" },
        exp: { $ref: "#/properties/v/anyOf/1e0" },
      },
    };
    const { schema: out, unresolved } = inlineAcyclicLocalJsonSchemaReferences(schema);
    assert.deepEqual(out.properties.ok, { type: "number" });
    assert.deepEqual(unresolved.map((issue) => issue.ref).sort(), [
      "#/properties/v/anyOf/01",
      "#/properties/v/anyOf/1e0",
    ]);
    assert.ok(unresolved.every((issue) => issue.reason === "unresolvable"));
  });

  it("leaves ref-free schemas untouched regardless of depth or size", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 40; i += 1) {
      deep = { type: "object", properties: { child: deep } };
    }
    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 12_000 }, (_, i) => [`f${String(i)}`, { type: "string" }]),
      ),
    };
    const huge = {
      type: "object",
      properties: { x: { type: "string", description: "中".repeat(200_000) } },
    };
    for (const schema of [deep, wide, huge]) {
      const result = inlineAcyclicLocalJsonSchemaReferences(schema);
      assert.deepEqual(result.unresolved, []);
      assert.deepEqual(result.schema, schema);
    }
  });

  it("measures the output limit in UTF-8 bytes", () => {
    const big = { type: "string", description: "中".repeat(60_000) };
    const schema = {
      type: "object",
      properties: { f0: big, f1: { $ref: "#/properties/f0" }, f2: { $ref: "#/properties/f0" } },
    };
    const { unresolved } = inlineAcyclicLocalJsonSchemaReferences(schema);
    assert.deepEqual(
      unresolved.map((issue) => issue.reason),
      ["limit"],
    );
  });

  it("recognises root-level definition references", () => {
    assert.equal(isRootDefinitionReference("#/$defs/node"), true);
    assert.equal(isRootDefinitionReference("#/definitions/a~1b"), true);
    assert.equal(isRootDefinitionReference("#/$defs/a/b"), false);
    assert.equal(isRootDefinitionReference("#/properties/x"), false);
    assert.equal(isRootDefinitionReference("https://example.com/s.json#/$defs/x"), false);
  });
});
