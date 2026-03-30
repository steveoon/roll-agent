import type { BrowserContextManager, Page, Platform } from "@roll-agent/browser";
import { PLATFORM_HOME, matchesPlatformHost } from "../platforms.ts";

export type ResolvedPlatformPage = {
  page: Page;
  reusedExistingPage: boolean;
};

export async function findExistingPlatformPage(
  ctxManager: BrowserContextManager,
  platform: Platform,
): Promise<Page | undefined> {
  return ctxManager.useExistingPage(platform, (page) => matchesPlatformHost(page.url(), platform));
}

export async function ensurePlatformHomePage(
  ctxManager: BrowserContextManager,
  platform: Platform,
): Promise<ResolvedPlatformPage> {
  const matchedPage = await findExistingPlatformPage(ctxManager, platform);
  const page = matchedPage ?? (await ctxManager.getPage(platform));

  await page.bringToFront().catch(() => {});

  if (!matchesPlatformHost(page.url(), platform)) {
    await page.goto(PLATFORM_HOME[platform], { waitUntil: "domcontentloaded" });
  }

  return {
    page,
    reusedExistingPage: matchedPage !== undefined,
  };
}
