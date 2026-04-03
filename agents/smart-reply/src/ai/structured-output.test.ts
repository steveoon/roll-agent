import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSchema } from "ai";
import { z } from "zod";
import { createStructuredOutputCompatibilitySchema } from "./structured-output.ts";

describe("createStructuredOutputCompatibilitySchema", () => {
  it("strips array keywords (maxItems) while preserving number constraints when only array rules given", async () => {
    const schema = z.object({
      tags: z.array(z.string()).max(2),
      confidence: z.number().min(0).max(1),
      nested: z.object({
        items: z.array(z.object({ label: z.string() })).max(3),
      }),
    });

    const compatibleSchema = createStructuredOutputCompatibilitySchema(schema, {
      unsupportedKeywordsByType: { array: ["maxItems"] },
    });
    const result = (await asSchema(compatibleSchema).jsonSchema) as {
      properties?: Record<string, unknown>;
    };
    const properties = result.properties as Record<string, unknown>;
    const tagsSchema = properties.tags as Record<string, unknown>;
    const confidenceSchema = properties.confidence as Record<string, unknown>;
    const nestedSchema = properties.nested as { properties?: Record<string, unknown> };
    const nestedItemsSchema = nestedSchema.properties?.items as Record<string, unknown>;

    assert.equal(tagsSchema.maxItems, undefined);
    assert.equal(nestedItemsSchema.maxItems, undefined);
    // number constraints preserved since no number rules
    assert.equal(confidenceSchema.maximum, 1);
  });

  it("strips both array and number keywords", async () => {
    const schema = z.object({
      confidence: z.number().min(0).max(1),
      count: z.number().int().min(1),
      tags: z.array(z.string()).max(5),
    });

    const compatibleSchema = createStructuredOutputCompatibilitySchema(schema, {
      unsupportedKeywordsByType: {
        array: ["maxItems"],
        number: ["maximum", "minimum"],
      },
    });
    const result = (await asSchema(compatibleSchema).jsonSchema) as {
      properties?: Record<string, unknown>;
    };
    const properties = result.properties as Record<string, unknown>;
    const confidenceSchema = properties.confidence as Record<string, unknown>;
    const countSchema = properties.count as Record<string, unknown>;
    const tagsSchema = properties.tags as Record<string, unknown>;

    assert.equal(confidenceSchema.maximum, undefined);
    assert.equal(confidenceSchema.minimum, undefined);
    assert.equal(countSchema.minimum, undefined);
    assert.equal(tagsSchema.maxItems, undefined);
    assert.equal(confidenceSchema.type, "number");
    // integer inherits number rules automatically
    assert.equal(countSchema.type, "integer");
  });

  it("strips exclusiveMaximum/exclusiveMinimum via number rules (integer inherits)", async () => {
    const schema = z.object({
      score: z.number().gt(0).lt(100),
    });

    const compatibleSchema = createStructuredOutputCompatibilitySchema(schema, {
      unsupportedKeywordsByType: {
        number: ["maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum"],
      },
    });
    const result = (await asSchema(compatibleSchema).jsonSchema) as {
      properties?: Record<string, unknown>;
    };
    const scoreSchema = (result.properties as Record<string, unknown>).score as Record<
      string,
      unknown
    >;

    assert.equal(scoreSchema.exclusiveMaximum, undefined);
    assert.equal(scoreSchema.exclusiveMinimum, undefined);
    assert.equal(scoreSchema.type, "number");
  });

  it("returns original schema when no rules provided", () => {
    const schema = z.object({ name: z.string() });
    const result = createStructuredOutputCompatibilitySchema(schema);
    assert.equal(result, schema);
  });

  it("returns original schema when rules are empty", () => {
    const schema = z.object({ name: z.string() });
    const result = createStructuredOutputCompatibilitySchema(schema, {
      unsupportedKeywordsByType: {},
    });
    assert.equal(result, schema);
  });
});
