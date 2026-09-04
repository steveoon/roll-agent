import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lookupCatalogContextWindow,
  MODEL_CATALOG_PROVIDER_IDS,
  trimModelCatalog,
  type ModelCatalogData,
} from "./model-catalog.ts";

const DATA: ModelCatalogData = {
  fetchedAt: "2026-09-04T00:00:00.000Z",
  providers: {
    openai: {
      "gpt-5.6-terra": { context: 1_050_000, input: 922_000 },
      "gpt-5.5": { context: 1_050_000, input: 922_000 },
    },
    anthropic: { "claude-sonnet-4-6": { context: 1_000_000 } },
    google: { "gemini-3.8-flash": { context: 1_048_576 } },
    "alibaba-cn": { "qwen3.8-max": { context: 1_000_000 } },
    alibaba: { "qwen-plus": { context: 131_072 }, "qwen3.8-max": { context: 5 } },
  },
};

test("lookupCatalogContextWindow prefers input over context and maps roll provider names", () => {
  assert.equal(lookupCatalogContextWindow(DATA, "openai", "gpt-5.6-terra"), 922_000);
  assert.equal(lookupCatalogContextWindow(DATA, "google", "gemini-3.8-flash"), 1_048_576);
  assert.equal(lookupCatalogContextWindow(DATA, "qwen", "qwen3.8-max"), 1_000_000);
  assert.equal(lookupCatalogContextWindow(DATA, "qwen", "qwen-plus"), 131_072);
});

test("lookupCatalogContextWindow tolerates -latest and date suffixes", () => {
  assert.equal(
    lookupCatalogContextWindow(DATA, "anthropic", "claude-sonnet-4-6-latest"),
    1_000_000,
  );
  assert.equal(
    lookupCatalogContextWindow(DATA, "anthropic", "claude-sonnet-4-6-20260217"),
    1_000_000,
  );
});

test("lookupCatalogContextWindow returns undefined for unknown provider or model", () => {
  assert.equal(lookupCatalogContextWindow(DATA, "openai", "gpt-9"), undefined);
  assert.equal(lookupCatalogContextWindow(DATA, "custom", "gpt-5.5"), undefined);
});

test("trimModelCatalog keeps only official providers and positive limits", () => {
  const raw = {
    openai: {
      models: {
        "gpt-5.5": { limit: { context: 1_050_000, input: 922_000, output: 128_000 }, cost: {} },
        "text-embedding-3": { limit: { context: 0 } },
        broken: { limit: { context: "big" } },
      },
    },
    "alibaba-cn": { models: { "qwen3.8-max": { limit: { context: 1_000_000 } } } },
    aihubmix: { models: { "gpt-5.5": { limit: { context: 1 } } } },
  };
  const trimmed = trimModelCatalog(raw, "2026-09-04T00:00:00.000Z");
  assert.deepEqual(Object.keys(trimmed.providers).sort(), ["alibaba-cn", "openai"]);
  assert.deepEqual(trimmed.providers.openai, {
    "gpt-5.5": { context: 1_050_000, input: 922_000 },
  });
  assert.equal(trimmed.fetchedAt, "2026-09-04T00:00:00.000Z");
  assert.throws(() => trimModelCatalog("nope", "2026-09-04T00:00:00.000Z"));
  assert.ok(MODEL_CATALOG_PROVIDER_IDS.includes("alibaba-cn"));
});
