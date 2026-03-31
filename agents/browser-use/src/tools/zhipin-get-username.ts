import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  collectUsernameEvidence,
  pickBestUsername,
  selectExistingZhipinPage,
} from "../pages/zhipin/username.ts";
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
  description: "获取当前登录的招聘者用户名，仅复用当前 runtime 已跟踪的 BOSS直聘页面。",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Getting zhipin username");

    try {
      const ctxManager = getContextManager();
      const page = await selectExistingZhipinPage(ctxManager);

      if (!page) {
        return {
          success: false,
          userName: "",
          error:
            "未找到当前 runtime 已跟踪的 BOSS直聘页面，请先执行 open_platform，或通过 list_pages + select_page 恢复跟踪。",
        };
      }

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
