import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import { ErrorCode } from "../errors/error-codes.ts";

// ========== Types ==========

const DulidayBrandItemSchema = z.object({
  id: z.number(),
  name: z.string(),
  aliases: z.array(z.string()),
  projectIdList: z.array(z.number()),
});

type DulidayBrandItem = z.infer<typeof DulidayBrandItemSchema>;

const DulidayBrandListResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.object({
    result: z.array(DulidayBrandItemSchema),
    total: z.number(),
  }),
});

export type BrandAliasMap = Map<string, string>;
export type BrandDictionary = Record<string, string[]>;

// ========== Cache ==========

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: {
  aliasMap: BrandAliasMap;
  dictionary: BrandDictionary;
  timestamp: number;
} | null = null;

function isCacheValid(): boolean {
  return cache !== null && Date.now() - cache.timestamp < CACHE_TTL_MS;
}

// ========== Constants ==========

const DULIDAY_BRAND_LIST_URL = "https://k8s.duliday.com/persistence/ai/api/brand/list";
const REQUEST_TIMEOUT_MS = 30_000;

// ========== API Fetch ==========

async function fetchBrandAliasesFromApi(dulidayToken?: string): Promise<DulidayBrandItem[]> {
  const token = dulidayToken || process.env.DULIDAY_TOKEN;
  if (!token) {
    throw new AppError({
      code: ErrorCode.CONFIG_MISSING_FIELD,
      message: "DULIDAY_TOKEN 未配置，无法获取品牌别名数据",
      userMessage: "品牌别名数据加载失败：缺少 Duliday Token 配置",
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(DULIDAY_BRAND_LIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Duliday-Token": token },
      body: JSON.stringify({ pageNum: 1, pageSize: 1000 }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new AppError({
        code: ErrorCode.NETWORK_HTTP_ERROR,
        message: `Duliday 品牌列表 API 返回 HTTP ${response.status}: ${response.statusText}`,
        userMessage: `品牌别名数据加载失败：服务端返回 ${response.status}`,
      });
    }

    const json: unknown = await response.json();
    const parsed = DulidayBrandListResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError({
        code: ErrorCode.VALIDATION_SCHEMA_ERROR,
        message: `Duliday 品牌列表响应格式校验失败: ${parsed.error.message}`,
        userMessage: "品牌别名数据加载失败：响应格式异常",
      });
    }

    return parsed.data.data.result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError({
        code: ErrorCode.NETWORK_TIMEOUT,
        message: `Duliday 品牌列表 API 请求超时 (${REQUEST_TIMEOUT_MS}ms)`,
        userMessage: "品牌别名数据加载超时，请稍后重试",
        cause: error,
      });
    }
    throw new AppError({
      code: ErrorCode.SYSTEM_DEPENDENCY_FAILED,
      message: `获取品牌别名数据失败: ${error instanceof Error ? error.message : String(error)}`,
      userMessage: "品牌别名数据加载失败，请检查网络连接",
      ...(error instanceof Error ? { cause: error } : {}),
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ========== Map Builders ==========

function buildMapsFromApiData(
  apiData: DulidayBrandItem[],
  actualBrands: Set<string>,
  brandMapping?: Record<string, string>,
): { dictionary: BrandDictionary; aliasMap: BrandAliasMap } {
  const dictionary: BrandDictionary = {};
  const aliasMap: BrandAliasMap = new Map();
  const normalizeAlias = (value: string): string => value.trim();
  const toAliasMapKey = (value: string): string =>
    normalizeAlias(value)
      .toLowerCase()
      .replace(/[\s._-]+/g, "");

  const registerAlias = (alias: string, brandName: string): void => {
    const key = toAliasMapKey(alias);
    if (!key) return;
    const existing = aliasMap.get(key);
    if (!existing || brandName.length > existing.length) {
      aliasMap.set(key, brandName);
    }
  };

  const sortedApiData = [...apiData].sort((a, b) => b.name.length - a.name.length);

  for (const item of sortedApiData) {
    const brandName = normalizeAlias(item.name);
    if (!brandName) continue;

    const allAliases = Array.from(
      new Set(
        [brandName, ...item.aliases.map(normalizeAlias).filter(Boolean)].filter(
          (alias) => alias !== brandName,
        ),
      ),
    );
    allAliases.unshift(brandName);
    dictionary[brandName] = allAliases;

    for (const alias of allAliases) {
      registerAlias(alias, brandName);
    }

    if (brandMapping && item.projectIdList.length > 0) {
      for (const projectId of item.projectIdList) {
        const localBrandName = brandMapping[String(projectId)];
        if (!localBrandName || localBrandName === brandName) continue;
        if (!localBrandName.includes(brandName)) continue;
        const prefix = localBrandName.replace(brandName, "");
        if (!prefix) continue;

        const regionalAliases = [localBrandName];
        for (const parentAlias of allAliases) {
          if (parentAlias === brandName) continue;
          regionalAliases.push(`${prefix}${parentAlias}`);
        }

        if (!dictionary[localBrandName]) {
          dictionary[localBrandName] = regionalAliases;
        } else {
          const existing = new Set(dictionary[localBrandName]);
          for (const alias of regionalAliases) {
            if (!existing.has(alias)) dictionary[localBrandName].push(alias);
          }
        }

        for (const alias of regionalAliases) {
          registerAlias(alias, localBrandName);
        }
      }
    }
  }

  for (const brand of actualBrands) {
    if (!dictionary[brand]) {
      dictionary[brand] = [brand];
      registerAlias(brand, brand);
    }
  }

  return { dictionary, aliasMap };
}

// ========== Public API ==========

async function ensureCachePopulated(dulidayToken?: string): Promise<void> {
  if (isCacheValid()) return;

  const apiData = await fetchBrandAliasesFromApi(dulidayToken);
  // 品牌映射在 Agent 模式下为空（不依赖 DB）
  const actualBrands = new Set<string>();
  const { dictionary, aliasMap } = buildMapsFromApiData(apiData, actualBrands);

  cache = { aliasMap, dictionary, timestamp: Date.now() };
}

export async function getSharedBrandDictionary(dulidayToken?: string): Promise<BrandDictionary> {
  await ensureCachePopulated(dulidayToken);
  return cache!.dictionary;
}

export async function getSharedBrandAliasMap(dulidayToken?: string): Promise<BrandAliasMap> {
  await ensureCachePopulated(dulidayToken);
  return cache!.aliasMap;
}
