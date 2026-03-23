import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  getDulidayToken,
  getDulidayJobListEndpoint,
  fetchAllJobListPages,
  FULL_INCLUDE_OPTIONS,
} from "../services/duliday-api.ts";
import { getSharedBrandAliasMap } from "../services/brand-alias.ts";
import { convertPositionsToZhipinData } from "../services/duliday-mapper.ts";
import { saveBrandConfig } from "../services/config-loader.ts";

export const syncBrandData = defineTool({
  name: "sync_brand_data",
  description:
    "从 Duliday API 拉取并同步品牌配置数据（门店、岗位、薪资等）到本地。可选传入品牌别名和城市名称作为过滤条件。",
  input: z.object({
    brandAlias: z.string().optional().describe("品牌别名（可选，配合 cityName 使用可按品牌过滤）"),
    cityName: z
      .string()
      .describe('城市名称（必填，Duliday API 要求至少提供城市作为筛选条件，如 "上海市"）'),
  }),
  output: z.object({
    success: z.boolean(),
    brandsCount: z.number(),
    storesCount: z.number(),
    positionsCount: z.number(),
    updatedAt: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input, ctx) => {
    const token = getDulidayToken();
    const endpoint = getDulidayJobListEndpoint();

    if (!token || !endpoint) {
      return {
        success: false,
        brandsCount: 0,
        storesCount: 0,
        positionsCount: 0,
        updatedAt: new Date().toISOString(),
        error: `缺少环境变量: ${[!token && "DULIDAY_TOKEN", !endpoint && "DULIDAY_JOB_LIST_URL"].filter(Boolean).join(", ")}`,
      };
    }

    if (!input.cityName) {
      return {
        success: false,
        brandsCount: 0,
        storesCount: 0,
        positionsCount: 0,
        updatedAt: new Date().toISOString(),
        error: 'cityName 为必填项，Duliday API 要求至少提供城市作为筛选条件（如 "上海市"）',
      };
    }

    try {
      ctx.logger.info("Fetching all job list pages from Duliday API...");
      const { items } = await fetchAllJobListPages(token, endpoint, {
        brandAlias: input.brandAlias ?? null,
        cityName: input.cityName ?? null,
        include: FULL_INCLUDE_OPTIONS,
      });

      let preferredDefaultBrandName = resolveFirstBrandName(items);
      if (!preferredDefaultBrandName && input.brandAlias) {
        preferredDefaultBrandName = await reverseLookupBrand(input.brandAlias, token);
      }
      if (!preferredDefaultBrandName && input.brandAlias) {
        preferredDefaultBrandName = input.brandAlias;
      }

      ctx.logger.info(
        `Resolved default brand: ${preferredDefaultBrandName ?? "自动推断"}, converting ${items.length} positions...`,
      );
      const zhipinData = convertPositionsToZhipinData(
        items,
        preferredDefaultBrandName,
        input.cityName,
      );

      saveBrandConfig(zhipinData);
      ctx.logger.info(
        `Brand config saved: ${zhipinData.brands.length} brands, ${zhipinData.brands.reduce((sum, brand) => sum + brand.stores.length, 0)} stores`,
      );

      const storesCount = zhipinData.brands.reduce((sum, brand) => sum + brand.stores.length, 0);
      const positionsCount = zhipinData.brands.reduce(
        (sum, brand) =>
          sum + brand.stores.reduce((inner, store) => inner + store.positions.length, 0),
        0,
      );

      return {
        success: true,
        brandsCount: zhipinData.brands.length,
        storesCount,
        positionsCount,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        success: false,
        brandsCount: 0,
        storesCount: 0,
        positionsCount: 0,
        updatedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveFirstBrandName(items: unknown[]): string | undefined {
  for (const item of items) {
    if (!isRecord(item)) continue;
    const basicInfo = isRecord(item.basicInfo) ? item.basicInfo : null;
    if (basicInfo && typeof basicInfo.brandName === "string" && basicInfo.brandName) {
      return basicInfo.brandName;
    }
  }
  return undefined;
}

async function reverseLookupBrand(
  alias: string,
  dulidayToken: string,
): Promise<string | undefined> {
  try {
    const aliasMap = await getSharedBrandAliasMap(dulidayToken);
    const key = alias
      .trim()
      .toLowerCase()
      .replace(/[\s._-]+/g, "");
    return aliasMap.get(key);
  } catch {
    return undefined;
  }
}
