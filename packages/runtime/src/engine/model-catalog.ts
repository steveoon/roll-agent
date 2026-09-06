import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const MODEL_CATALOG_SOURCE_URL = "https://models.dev/api.json";

export const MODEL_CATALOG_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "xai",
  "alibaba-cn",
  "alibaba",
] as const;

export type ModelCatalogProviderId = (typeof MODEL_CATALOG_PROVIDER_IDS)[number];

const CATALOG_PROVIDER_KEYS: Readonly<Record<string, readonly ModelCatalogProviderId[]>> = {
  openai: ["openai"],
  anthropic: ["anthropic"],
  google: ["google"],
  deepseek: ["deepseek"],
  xai: ["xai"],
  qwen: ["alibaba-cn", "alibaba"],
};

const modelCatalogLimitSchema = z.object({
  context: z.number().int().positive(),
  input: z.number().int().positive().optional(),
});

export const modelCatalogDataSchema = z.object({
  fetchedAt: z.string().datetime(),
  providers: z.record(z.string(), z.record(z.string(), modelCatalogLimitSchema)),
});

export type ModelCatalogLimit = z.infer<typeof modelCatalogLimitSchema>;
export type ModelCatalogData = z.infer<typeof modelCatalogDataSchema>;

const rawCatalogSchema = z.record(
  z.string(),
  z.object({ models: z.record(z.string(), z.object({ limit: z.unknown().optional() })) }),
);

function isCatalogProviderId(value: string): value is ModelCatalogProviderId {
  return MODEL_CATALOG_PROVIDER_IDS.some((candidate) => candidate === value);
}

export function trimModelCatalog(raw: unknown, fetchedAt: string): ModelCatalogData {
  const parsed = rawCatalogSchema.parse(raw);
  const providers: Record<string, Record<string, ModelCatalogLimit>> = {};
  for (const [providerId, provider] of Object.entries(parsed)) {
    if (!isCatalogProviderId(providerId)) {
      continue;
    }
    const models: Record<string, ModelCatalogLimit> = {};
    for (const [modelId, model] of Object.entries(provider.models)) {
      const limit = modelCatalogLimitSchema.safeParse(model.limit);
      if (limit.success) {
        models[modelId] = {
          context: limit.data.context,
          ...(limit.data.input !== undefined ? { input: limit.data.input } : {}),
        };
      }
    }
    if (Object.keys(models).length > 0) {
      providers[providerId] = models;
    }
  }
  const data = modelCatalogDataSchema.parse({ fetchedAt, providers });
  if (!hasCatalogModels(data)) {
    throw new Error("model catalog contains no supported models");
  }
  return data;
}

function catalogModelCount(data: ModelCatalogData): number {
  return Object.values(data.providers).reduce(
    (count, models) => count + Object.keys(models).length,
    0,
  );
}

function hasCatalogModels(data: ModelCatalogData): boolean {
  return catalogModelCount(data) > 0;
}

const DATE_SUFFIX_PATTERN = /-\d{8}$/u;
const LATEST_SUFFIX = "-latest";

function modelNameCandidates(modelName: string): readonly string[] {
  const candidates = [modelName];
  let current = modelName;
  while (true) {
    const next = current.endsWith(LATEST_SUFFIX)
      ? current.slice(0, -LATEST_SUFFIX.length)
      : DATE_SUFFIX_PATTERN.test(current)
        ? current.replace(DATE_SUFFIX_PATTERN, "")
        : undefined;
    if (next === undefined || next.length === 0) {
      return candidates;
    }
    candidates.push(next);
    current = next;
  }
}

export function lookupCatalogContextWindow(
  data: ModelCatalogData,
  provider: string,
  modelName: string,
): number | undefined {
  const keys = CATALOG_PROVIDER_KEYS[provider] ?? [provider];
  const candidates = modelNameCandidates(modelName);
  for (const key of keys) {
    const models = data.providers[key];
    if (!models) {
      continue;
    }
    for (const candidate of candidates) {
      const limit = models[candidate];
      if (limit) {
        return limit.input ?? limit.context;
      }
    }
  }
  return undefined;
}

export const MODEL_CATALOG_REFRESH_RESULTS = {
  skipped: "skipped",
  refreshed: "refreshed",
  failed: "failed",
} as const;

export type ModelCatalogRefreshResult =
  (typeof MODEL_CATALOG_REFRESH_RESULTS)[keyof typeof MODEL_CATALOG_REFRESH_RESULTS];

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ModelCatalogOptions {
  readonly snapshot: ModelCatalogData;
  readonly cachePath?: string;
  readonly ttlMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export function defaultModelCatalogCachePath(): string {
  return resolve(homedir(), ".roll-agent", "cache", "model-catalog.json");
}

function readCachedCatalog(cachePath: string): ModelCatalogData | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    const result = modelCatalogDataSchema.safeParse(parsed);
    return result.success && hasCatalogModels(result.data) ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function isUsableCachedCatalog(
  cached: ModelCatalogData,
  snapshot: ModelCatalogData,
  nowMs: number,
): boolean {
  const fetchedAtMs = Date.parse(cached.fetchedAt);
  return fetchedAtMs <= nowMs && fetchedAtMs > Date.parse(snapshot.fetchedAt);
}

export class ModelCatalog {
  private readonly snapshot: ModelCatalogData;
  private readonly cachePath: string | undefined;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private current: ModelCatalogData | undefined;

  constructor(options: ModelCatalogOptions) {
    this.snapshot = options.snapshot;
    this.cachePath = options.cachePath;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  data(): ModelCatalogData {
    if (this.current) {
      return this.current;
    }
    const cached = this.cachePath === undefined ? undefined : readCachedCatalog(this.cachePath);
    this.current =
      cached && isUsableCachedCatalog(cached, this.snapshot, this.now()) ? cached : this.snapshot;
    return this.current;
  }

  lookup(provider: string, modelName: string): number | undefined {
    return lookupCatalogContextWindow(this.data(), provider, modelName);
  }

  async refreshIfStale(): Promise<ModelCatalogRefreshResult> {
    const cachePath = this.cachePath;
    if (cachePath === undefined) {
      return MODEL_CATALOG_REFRESH_RESULTS.skipped;
    }
    const nowMs = this.now();
    const ageMs = nowMs - Date.parse(this.data().fetchedAt);
    if (ageMs >= 0 && ageMs < this.ttlMs) {
      return MODEL_CATALOG_REFRESH_RESULTS.skipped;
    }
    try {
      const response = await this.fetchImpl(MODEL_CATALOG_SOURCE_URL, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return MODEL_CATALOG_REFRESH_RESULTS.failed;
      }
      const next = trimModelCatalog(await response.json(), new Date(nowMs).toISOString());
      mkdirSync(dirname(cachePath), { recursive: true });
      const tempPath = `${cachePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(next));
      renameSync(tempPath, cachePath);
      this.current = next;
      return MODEL_CATALOG_REFRESH_RESULTS.refreshed;
    } catch {
      return MODEL_CATALOG_REFRESH_RESULTS.failed;
    }
  }
}
