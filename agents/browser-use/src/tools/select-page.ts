import { defineTool } from "@roll-agent/sdk";
import { BrowserPageInfoSchema, PlatformSchema } from "@roll-agent/browser";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { detectPlatformFromUrl } from "../platforms.ts";

const SelectPageInputSchema = z.object({
  platform: PlatformSchema.describe("要将该页面绑定为当前活跃页的平台"),
  pageId: z.string().describe("通过 list_pages 返回的 pageId"),
});

const SelectPageOutputSchema = z.object({
  success: z.boolean(),
  page: BrowserPageInfoSchema,
});

export const selectPage = defineTool({
  name: "select_page",
  description: "将指定 pageId 绑定为平台当前活跃页，并切换到前台。",
  input: SelectPageInputSchema,
  output: SelectPageOutputSchema,
  execute: async (input, ctx) => {
    const ctxManager = getContextManager();

    ctx.logger.info(`Selecting page ${input.pageId} for ${input.platform}`);

    const page = await ctxManager.selectPage(input.platform, input.pageId);
    const url = page.url();
    const title = await page.title().catch(() => "");

    return {
      success: true,
      page: {
        pageId: ctxManager.getPageId(page),
        url,
        title,
        boundPlatform: ctxManager.getBoundPlatformForPage(page) ?? null,
        detectedPlatform: detectPlatformFromUrl(url) ?? null,
        isSelectedForPlatform: ctxManager.isSelectedPageForPlatform(page),
      },
    };
  },
});
