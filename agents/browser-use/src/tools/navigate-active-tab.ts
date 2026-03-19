import { defineTool } from "@roll-agent/sdk";
import { BrowserPageInfoSchema } from "@roll-agent/browser";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { detectPlatformFromUrl } from "../platforms.ts";

const NavigateActiveTabInputSchema = z.object({
  url: z.string().url().describe("要导航到的目标 URL"),
});

const NavigateActiveTabOutputSchema = z.object({
  success: z.boolean(),
  page: BrowserPageInfoSchema,
});

export const navigateActiveTab = defineTool({
  name: "navigate_active_tab",
  description: "将当前激活的浏览器 tab 导航到指定 URL；若 URL 属于已知平台，会自动绑定该平台当前活跃页。",
  input: NavigateActiveTabInputSchema,
  output: NavigateActiveTabOutputSchema,
  execute: async (input, ctx) => {
    const ctxManager = getContextManager();

    ctx.logger.info(`Navigating active tab to ${input.url}`);

    const page = await ctxManager.getActivePage();
    if (!page) {
      throw new Error(
        "No active browser tab detected. Use open_platform or select_page first.",
      );
    }

    await page.bringToFront().catch(() => {});
    await page.goto(input.url, { waitUntil: "domcontentloaded" });

    const detectedPlatform = detectPlatformFromUrl(page.url());
    if (detectedPlatform) {
      await ctxManager.selectPage(detectedPlatform, ctxManager.getPageId(page));
    } else {
      ctxManager.clearBindingForPage(page);
    }

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
