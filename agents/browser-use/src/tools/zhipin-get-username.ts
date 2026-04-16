import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { collectUsernameEvidence, pickBestUsername } from "../pages/zhipin/username.ts";
import { getContextManager } from "../runtime-holder.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  userName: z.string(),
  usedSelector: z.string().optional(),
  usedStrategy: z.string().optional(),
  source: z.string().optional(),
  error: z.string().optional(),
});

export const zhipinGetUsername = defineTool({
  name: "zhipin_get_username",
  description: "获取当前登录的招聘者用户名",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Getting zhipin username");

    try {
      const ctxManager = getContextManager();
      const page = await ctxManager.getPage("zhipin");

      await page.bringToFront().catch(() => {});

      const evidence = await collectUsernameEvidence(page);
      const result = pickBestUsername(evidence);

      if (!result.found) {
        return {
          success: false,
          userName: "",
          error: "未找到用户名，请确认当前页面已登录招聘者账号。",
        };
      }

      ctx.logger.info(
        `Username: ${result.userName} (strategy: ${result.strategy}, source: ${result.source})`,
      );
      return {
        success: true,
        userName: result.userName,
        usedSelector: result.strategy === "css-fallback" ? result.source : undefined,
        usedStrategy: result.strategy,
        source: result.source,
      };
    } catch (error) {
      return {
        success: false,
        userName: "",
        error: error instanceof Error ? `获取用户名失败：${error.message}` : "获取用户名失败",
      };
    }
  },
});
