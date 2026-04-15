import type { BrowserContextManager, BrowserInspectablePage, BrowserPageInfo, Page } from "@roll-agent/browser";
import { detectPlatformFromUrl } from "./platforms.ts";

export function toNativePageInfo(
  ctxManager: BrowserContextManager,
  page: BrowserInspectablePage,
): BrowserPageInfo {
  const detectedPlatform = detectPlatformFromUrl(page.url) ?? null;

  return {
    pageId: page.targetId,
    url: page.url,
    title: page.title,
    boundPlatform: ctxManager.getBoundPlatformForNativePage(page.targetId) ?? null,
    detectedPlatform,
    isSelectedForPlatform: ctxManager.isNativePageSelected(page.targetId),
  };
}

export async function toAttachedPageInfo(
  ctxManager: BrowserContextManager,
  page: Page,
): Promise<BrowserPageInfo> {
  const url = page.url();

  return {
    pageId: ctxManager.getPageId(page),
    url,
    title: await page.title().catch(() => ""),
    boundPlatform: ctxManager.getBoundPlatformForPage(page) ?? null,
    detectedPlatform: detectPlatformFromUrl(url) ?? null,
    isSelectedForPlatform: ctxManager.isSelectedPageForPlatform(page),
  };
}
