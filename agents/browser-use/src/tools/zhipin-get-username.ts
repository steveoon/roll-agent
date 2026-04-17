import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getCurrentZhipinRecruiterIdentity } from "../pages/zhipin/recruiter-identity.ts";
import { getContextManager } from "../runtime-holder.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  username: z.string(),
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

      const identity = await getCurrentZhipinRecruiterIdentity(page);

      ctx.logger.info(
        `Username: ${identity.username} (strategy: ${identity.strategy}, source: ${identity.source})`,
      );
      return {
        success: true,
        username: identity.username,
        usedSelector: identity.strategy === "css-fallback" ? identity.source : undefined,
        usedStrategy: identity.strategy,
        source: identity.source,
      };
    } catch (error) {
      return {
        success: false,
        username: "",
        error: error instanceof Error ? `获取用户名失败：${error.message}` : "获取用户名失败",
      };
    }
  },
});
