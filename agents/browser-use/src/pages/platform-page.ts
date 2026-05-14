import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
  BrowserActionPolicyOptions,
  Page,
  Platform,
} from "@roll-agent/browser";
import { PLATFORM_HOME, matchesPlatformHost } from "../platforms.ts";

export async function findTrackedPlatformPage(
  ctxManager: BrowserContextManager,
  platform: Platform,
): Promise<Page | undefined> {
  return ctxManager.useTrackedPage(platform, (page) => matchesPlatformHost(page.url(), platform));
}

export async function findOpenPlatformTarget(
  runtime: BrowserRuntime,
  platform: Platform,
): Promise<BrowserInspectablePage | undefined> {
  const pages = await runtime.listNativePages();
  return pages.find((page) => matchesPlatformHost(page.url, platform));
}

export async function openPlatformHomeTarget(
  runtime: BrowserRuntime,
  platform: Platform,
  options: BrowserActionPolicyOptions = {},
): Promise<{ page: BrowserInspectablePage; reusedExistingPage: boolean }> {
  const matchedPage = await findOpenPlatformTarget(runtime, platform);
  if (matchedPage) {
    await runtime.activateNativePage(matchedPage.targetId);
    return {
      page: matchedPage,
      reusedExistingPage: true,
    };
  }

  const page = await runtime.openNativePage(PLATFORM_HOME[platform], options);
  return {
    page,
    reusedExistingPage: false,
  };
}
