import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { PlatformSchema } from "@roll-agent/browser";
import { getContextManager } from "../runtime-holder.ts";
import { ensurePlatformHomePage } from "../pages/platform-page.ts";

const OpenPlatformInputSchema = z.object({
  platform: PlatformSchema.describe("目标平台：`zhipin` 代表 BOSS直聘，`yupao` 代表鱼泡"),
});

const OpenPlatformOutputSchema = z.object({
  success: z.boolean(),
  platform: PlatformSchema,
  url: z.string(),
  reusedExistingTab: z.boolean(),
});

export const openPlatform = defineTool({
  name: "open_platform",
  description: "打开并聚焦招聘平台主页，供用户手动登录或后续执行站内操作。",
  input: OpenPlatformInputSchema,
  output: OpenPlatformOutputSchema,
  execute: async (input, ctx) => {
    const { platform } = input;
    const ctxManager = getContextManager();

    ctx.logger.info(`Opening platform page for ${platform}`);

    const { page, reusedExistingPage } = await ensurePlatformHomePage(ctxManager, platform);

    return {
      success: true,
      platform,
      url: page.url(),
      reusedExistingTab: reusedExistingPage,
    };
  },
});
