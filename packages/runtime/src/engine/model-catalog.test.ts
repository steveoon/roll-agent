import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultModelCatalogCachePath,
  lookupCatalogContextWindow,
  MODEL_CATALOG_PROVIDER_IDS,
  MODEL_CATALOG_REFRESH_RESULTS,
  ModelCatalog,
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
  assert.equal(
    lookupCatalogContextWindow(DATA, "anthropic", "claude-sonnet-4-6-latest-20260217"),
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

const SNAPSHOT: ModelCatalogData = {
  fetchedAt: "2026-09-01T00:00:00.000Z",
  providers: { openai: { "gpt-5.5": { context: 1_050_000, input: 922_000 } } },
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("ModelCatalog falls back to the bundled snapshot without a cache path", () => {
  const catalog = new ModelCatalog({ snapshot: SNAPSHOT });
  assert.equal(catalog.lookup("openai", "gpt-5.5"), 922_000);
  assert.equal(catalog.data().fetchedAt, SNAPSHOT.fetchedAt);
});

test("ModelCatalog prefers a newer on-disk cache and ignores a corrupt one", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-model-catalog-"));
  try {
    const cachePath = join(dir, "model-catalog.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: "2026-09-03T00:00:00.000Z",
        providers: { openai: { "gpt-5.6-terra": { context: 1_050_000, input: 922_000 } } },
      }),
    );
    const fresh = new ModelCatalog({ snapshot: SNAPSHOT, cachePath });
    assert.equal(fresh.lookup("openai", "gpt-5.6-terra"), 922_000);
    assert.equal(fresh.lookup("openai", "gpt-5.5"), undefined);

    writeFileSync(cachePath, "{not json");
    const corrupt = new ModelCatalog({ snapshot: SNAPSHOT, cachePath });
    assert.equal(corrupt.lookup("openai", "gpt-5.5"), 922_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ModelCatalog ignores a future-dated cache and refreshes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-model-catalog-"));
  try {
    const cachePath = join(dir, "model-catalog.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: "9999-01-01T00:00:00.000Z",
        providers: { openai: { poisoned: { context: 999_999_999 } } },
      }),
    );
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          openai: { models: { "gpt-5.6-terra": { limit: { context: 1_050_000 } } } },
        }),
      );
    };
    const catalog = new ModelCatalog({
      snapshot: SNAPSHOT,
      cachePath,
      now: () => Date.parse("2026-09-04T00:00:00.000Z"),
      fetchImpl,
    });
    assert.equal(catalog.lookup("openai", "gpt-5.5"), 922_000);
    assert.equal(await catalog.refreshIfStale(), MODEL_CATALOG_REFRESH_RESULTS.refreshed);
    assert.equal(fetchCount, 1);
    assert.equal(catalog.lookup("openai", "poisoned"), undefined);
    assert.equal(catalog.lookup("openai", "gpt-5.6-terra"), 1_050_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ModelCatalog rejects an empty official refresh and preserves current data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-model-catalog-"));
  try {
    const cachePath = join(dir, "model-catalog.json");
    const catalog = new ModelCatalog({
      snapshot: SNAPSHOT,
      cachePath,
      now: () => Date.parse("2026-09-04T00:00:00.000Z"),
      fetchImpl: fakeFetch({ unofficial: { models: { fake: { limit: { context: 123 } } } } }),
    });
    const before = catalog.data();
    assert.equal(await catalog.refreshIfStale(), MODEL_CATALOG_REFRESH_RESULTS.failed);
    assert.equal(catalog.data(), before);
    assert.equal(catalog.lookup("openai", "gpt-5.5"), 922_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ModelCatalog.refreshIfStale skips within ttl, refreshes when stale, and survives failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-model-catalog-"));
  try {
    const cachePath = join(dir, "model-catalog.json");
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.parse("2026-09-04T00:00:00.000Z");
    const raw = {
      openai: { models: { "gpt-5.6-terra": { limit: { context: 1_050_000, input: 922_000 } } } },
    };

    const withinTtl = new ModelCatalog({
      snapshot: { ...SNAPSHOT, fetchedAt: "2026-09-03T12:00:00.000Z" },
      cachePath,
      fetchImpl: fakeFetch(raw),
      now: () => now,
    });
    assert.equal(await withinTtl.refreshIfStale(), MODEL_CATALOG_REFRESH_RESULTS.skipped);

    const stale = new ModelCatalog({
      snapshot: SNAPSHOT,
      cachePath,
      ttlMs: dayMs,
      fetchImpl: fakeFetch(raw),
      now: () => now,
    });
    assert.equal(await stale.refreshIfStale(), MODEL_CATALOG_REFRESH_RESULTS.refreshed);
    assert.equal(stale.lookup("openai", "gpt-5.6-terra"), 922_000);
    const written = JSON.parse(readFileSync(cachePath, "utf8")) as ModelCatalogData;
    assert.equal(written.fetchedAt, new Date(now).toISOString());

    const failing = new ModelCatalog({
      snapshot: SNAPSHOT,
      cachePath: join(dir, "other.json"),
      fetchImpl: fakeFetch({ error: true }, 500),
      now: () => now,
    });
    assert.equal(await failing.refreshIfStale(), MODEL_CATALOG_REFRESH_RESULTS.failed);
    assert.equal(failing.lookup("openai", "gpt-5.5"), 922_000);

    const noCache = new ModelCatalog({
      snapshot: SNAPSHOT,
      fetchImpl: fakeFetch(raw),
      now: () => now,
    });
    assert.equal(await noCache.refreshIfStale(), MODEL_CATALOG_REFRESH_RESULTS.skipped);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultModelCatalogCachePath lives under ~/.roll-agent/cache", () => {
  assert.match(defaultModelCatalogCachePath(), /\.roll-agent[\\/]cache[\\/]model-catalog\.json$/u);
});
