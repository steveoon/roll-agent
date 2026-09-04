import { test } from "node:test";
import assert from "node:assert/strict";
import { modelCatalogDataSchema } from "./model-catalog.ts";
import { createDefaultModelCatalog } from "./model-catalog-default.ts";
import { MODEL_CATALOG_SNAPSHOT } from "./model-catalog-snapshot.ts";

test("bundled model catalog snapshot is valid and covers the default models", () => {
  assert.doesNotThrow(() => modelCatalogDataSchema.parse(MODEL_CATALOG_SNAPSHOT));
  const catalog = createDefaultModelCatalog();
  assert.equal(catalog.lookup("openai", "gpt-5.6-terra"), 922_000);
  assert.equal(catalog.lookup("openai", "gpt-5.5"), 922_000);
  assert.equal(catalog.lookup("google", "gemini-3.8-flash"), 1_048_576);
  assert.equal(catalog.lookup("qwen", "qwen3.8-max"), 1_000_000);
  assert.equal(catalog.lookup("xai", "grok-4.5"), 500_000);
  assert.equal(catalog.lookup("anthropic", "claude-sonnet-4-6"), 1_000_000);
  assert.equal(catalog.lookup("deepseek", "deepseek-v4-flash"), 1_000_000);
});
