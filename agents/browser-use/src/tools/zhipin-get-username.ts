import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  userName: z.string(),
  error: z.string().optional(),
});

export const zhipinGetUsername = defineTool({
  name: "zhipin_get_username",
  description: "获取当前登录的招聘者用户名",
  input: z.object({}),
  output: OutputSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Getting zhipin username");

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");

    const result = await page.evaluate(() => {
      const selectors = [
        "#header .label-name",
        "#header .user-name",
        ".user-name",
        '[class*="user-name"]',
        '[class*="username"]',
        ".nav-logout .user-name",
        ".nav-user .user-name",
        ".top-profile .user-name",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent?.trim() ?? "";
          if (text.length > 0 && text.length <= 30) {
            return { found: true as const, userName: text };
          }
        }
      }
      return { found: false as const };
    });

    if (!result.found) {
      return { success: false, userName: "", error: "未找到用户名" };
    }

    ctx.logger.info(`Username: ${result.userName}`);
    return { success: true, userName: result.userName };
  },
});
