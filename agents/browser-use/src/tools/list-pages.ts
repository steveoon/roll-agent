import { defineTool } from "@roll-agent/sdk";
import { BrowserPageInfoSchema, PlatformSchema } from "@roll-agent/browser";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { toNativePageInfo } from "../page-info.ts";

const ListPagesInputSchema = z.object({
  platform: PlatformSchema.optional().describe("可选：仅返回指定平台相关的页面"),
});

const ListPagesOutputSchema = z.object({
  pages: z.array(BrowserPageInfoSchema),
});

export const listPages = defineTool({
  name: "list_pages",
  description: "通过原生 CDP 列出当前浏览器可见页面及其可选择的 pageId；登录前该值等同于原生 targetId。",
  input: ListPagesInputSchema,
  output: ListPagesOutputSchema,
  execute: async (input, ctx) => {
    const ctxManager = getContextManager();

    ctx.logger.info("Listing browser pages");

    const pageInfos = (await ctxManager.listNativePages()).map((page) => toNativePageInfo(ctxManager, page));

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
