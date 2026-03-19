import { defineTool } from "@roll-agent/sdk";
import { BrowserPageInfoSchema, PlatformSchema } from "@roll-agent/browser";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { detectPlatformFromUrl } from "../platforms.ts";

const ListPagesInputSchema = z.object({
  platform: PlatformSchema.optional().describe("可选：仅返回指定平台相关的页面"),
});

const ListPagesOutputSchema = z.object({
  pages: z.array(BrowserPageInfoSchema),
});

export const listPages = defineTool({
  name: "list_pages",
  description: "列出当前浏览器 runtime 中可见的页面及其 pageId，供后续选择和聚焦。",
  input: ListPagesInputSchema,
  output: ListPagesOutputSchema,
  execute: async (input, ctx) => {
    const ctxManager = getContextManager();

    ctx.logger.info("Listing browser pages");

    const pageInfos = await Promise.all(
      ctxManager.listPages().map(async (page) => {
        const url = page.url();
        const boundPlatform = ctxManager.getBoundPlatformForPage(page) ?? null;
        const detectedPlatform = detectPlatformFromUrl(url) ?? null;
        const title = await page.title().catch(() => "");

        return {
          pageId: ctxManager.getPageId(page),
          url,
          title,
          boundPlatform,
          detectedPlatform,
          isSelectedForPlatform: ctxManager.isSelectedPageForPlatform(page),
        };
      }),
    );

    const pages =
      input.platform === undefined
        ? pageInfos
        : pageInfos.filter(
            (page) =>
              page.boundPlatform === input.platform || page.detectedPlatform === input.platform,
          );

    return { pages };
  },
});
