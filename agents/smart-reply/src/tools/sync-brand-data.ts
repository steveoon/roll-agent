import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { ZhipinDataSchema } from "../types/zhipin.ts";
import { ReplyPolicyConfigSchema } from "../types/reply-policy.ts";
import type { ReplyPolicyConfig } from "../types/reply-policy.ts";
import { saveBrandConfig, saveReplyPolicy } from "../services/config-loader.ts";

export const syncBrandData = defineTool({
  name: "sync_brand_data",
  description:
    "同步品牌配置数据和回复策略到本地存储。Agent 运行依赖该数据，首次使用前需先调用此工具写入。",
  input: z.object({
    data: ZhipinDataSchema.describe("品牌配置数据（包含门店、岗位、薪资等）"),
    replyPolicy:
      ReplyPolicyConfigSchema.optional().describe("回复策略配置（可选，不传则使用默认策略）"),
  }),
  output: z.object({
    success: z.boolean(),
    brandsCount: z.number(),
    storesCount: z.number(),
    updatedAt: z.string(),
  }),
  execute: async (input, ctx) => {
    ctx.logger.info("Syncing brand data...");

    saveBrandConfig(input.data);
    ctx.logger.info(
      `Brand config saved: ${Object.keys(input.data.brands).length} brands, ${input.data.stores.length} stores`,
    );

    if (input.replyPolicy) {
      saveReplyPolicy(input.replyPolicy as ReplyPolicyConfig);
      ctx.logger.info("Reply policy saved");
    }

    return {
      success: true,
      brandsCount: Object.keys(input.data.brands).length,
      storesCount: input.data.stores.length,
      updatedAt: new Date().toISOString(),
    };
  },
});
