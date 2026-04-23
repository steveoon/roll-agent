import type { AgentContext } from "@roll-agent/sdk";
import { defineTool } from "@roll-agent/sdk";
import type { BrowserContextManager, BrowserPageInfo, Page, Platform } from "@roll-agent/browser";
import { BrowserPageInfoSchema } from "@roll-agent/browser";
import { z } from "zod";
import { findTrackedPlatformPage } from "../pages/platform-page.ts";
import { getContextManager } from "../runtime-holder.ts";
import { detectPlatformFromUrl, matchesPlatformHost } from "../platforms.ts";
import { toAttachedPageInfo } from "../page-info.ts";

const NavigateActiveTabInputSchema = z.object({
  url: z.string().url().describe("要导航到的目标 URL"),
});

const NavigateActiveTabOutputSchema = z.object({
  success: z.boolean(),
  page: BrowserPageInfoSchema,
});

type NavigateActiveTabDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly detectPlatformFromUrl: typeof detectPlatformFromUrl;
  readonly matchesPlatformHost: typeof matchesPlatformHost;
  readonly findTrackedPlatformPage: typeof findTrackedPlatformPage;
  readonly toAttachedPageInfo: typeof toAttachedPageInfo;
};

let navigateActiveTabDepsOverride: Partial<NavigateActiveTabDeps> | undefined;

function getNavigateActiveTabDeps(): NavigateActiveTabDeps {
  return {
    getContextManager,
    detectPlatformFromUrl,
    matchesPlatformHost,
    findTrackedPlatformPage,
    toAttachedPageInfo,
    ...navigateActiveTabDepsOverride,
  };
}

export function setNavigateActiveTabDepsForTests(
  override: Partial<NavigateActiveTabDeps> | undefined,
): void {
  navigateActiveTabDepsOverride = override;
}

async function resolveNativePlatformPage(
  ctxManager: BrowserContextManager,
  deps: NavigateActiveTabDeps,
  platform: Platform,
): Promise<Page | undefined> {
  const nativePages = await ctxManager.listNativePages();
  const matchedNative = nativePages.find((page) => deps.matchesPlatformHost(page.url, platform));
  if (!matchedNative) {
    return undefined;
  }

  await ctxManager.selectNativePage(platform, matchedNative.targetId);
  return await ctxManager.getPage(platform);
}

async function resolveNavigationTarget(
  ctxManager: BrowserContextManager,
  deps: NavigateActiveTabDeps,
  url: string,
  logger: AgentContext["logger"],
): Promise<{ page: Page; platform?: Platform }> {
  const inputPlatform = deps.detectPlatformFromUrl(url);
  if (!inputPlatform) {
    const activePage = await ctxManager.getActivePage();
    if (!activePage) {
      throw new Error("No active browser tab detected. Use open_platform or select_page first.");
    }
    return { page: activePage };
  }

  const trackedPage = await deps.findTrackedPlatformPage(ctxManager, inputPlatform);
  if (trackedPage) {
    logger.info(`Reusing tracked ${inputPlatform} page instead of navigating the current unrelated tab`);
    return { page: trackedPage, platform: inputPlatform };
  }

  const nativePage = await resolveNativePlatformPage(ctxManager, deps, inputPlatform);
  if (nativePage) {
    logger.info(`Reusing native ${inputPlatform} page instead of navigating the current unrelated tab`);
    return { page: nativePage, platform: inputPlatform };
  }

  const activePage = await ctxManager.getActivePage();
  if (!activePage) {
    throw new Error("No active browser tab detected. Use open_platform or select_page first.");
  }

  logger.warn(
    `No existing ${inputPlatform} page found; falling back to navigating the current active tab`,
  );
  return { page: activePage, platform: inputPlatform };
}

async function bindPlatformPage(
  ctxManager: BrowserContextManager,
  page: Page,
  platform: Platform,
): Promise<Page> {
  return await ctxManager.selectAttachedPage(platform, ctxManager.getPageId(page));
}

async function navigateIfNeeded(page: Page, url: string): Promise<void> {
  if (page.url() === url) {
    return;
  }

  await page.goto(url, { waitUntil: "domcontentloaded" });
}

export const navigateActiveTab = defineTool({
  name: "navigate_active_tab",
  description:
    "导航到指定 URL；若 URL 属于已知平台（Boss/鱼泡），优先复用已打开的平台页，避免把无关 tab 导航成第二个平台页。",
  input: NavigateActiveTabInputSchema,
  output: NavigateActiveTabOutputSchema,
  execute: async (input, ctx) => {
    const deps = getNavigateActiveTabDeps();
    const ctxManager = deps.getContextManager();

    ctx.logger.info(`Navigating active tab to ${input.url}`);

    const { page: targetPage, platform: inputPlatform } = await resolveNavigationTarget(
      ctxManager,
      deps,
      input.url,
      ctx.logger,
    );

    await targetPage.bringToFront().catch(() => {});
    await navigateIfNeeded(targetPage, input.url);

    const detectedPlatform = inputPlatform ?? deps.detectPlatformFromUrl(targetPage.url());
    const boundPage = detectedPlatform
      ? await bindPlatformPage(ctxManager, targetPage, detectedPlatform)
      : targetPage;
    if (detectedPlatform) {
      ctx.logger.info(`Bound navigated page to ${detectedPlatform}`);
    } else {
      ctxManager.clearBindingForPage(targetPage);
    }

    return {
      success: true,
      page: (await deps.toAttachedPageInfo(ctxManager, boundPage)) satisfies BrowserPageInfo,
    };
  },
});
