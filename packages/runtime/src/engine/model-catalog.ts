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
  return modelCatalogDataSchema.parse({ fetchedAt, providers });
}

const DATE_SUFFIX_PATTERN = /-\d{8}$/u;
const LATEST_SUFFIX = "-latest";

function modelNameCandidates(modelName: string): readonly string[] {
  const candidates = [modelName];
  if (modelName.endsWith(LATEST_SUFFIX)) {
    candidates.push(modelName.slice(0, -LATEST_SUFFIX.length));
  }
  if (DATE_SUFFIX_PATTERN.test(modelName)) {
    candidates.push(modelName.replace(DATE_SUFFIX_PATTERN, ""));
  }
  return candidates;
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
