import { setTimeout as delay } from "node:timers/promises";
import type { AgentContext } from "@roll-agent/sdk";
import { defineTool } from "@roll-agent/sdk";
import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserPageInfo,
  BrowserRuntime,
  NativeCdpController,
  Platform,
} from "@roll-agent/browser";
import { BrowserPageInfoSchema } from "@roll-agent/browser";
import { z } from "zod";
import { getContextManager, getRuntime } from "../runtime-holder.ts";
import { detectPlatformFromUrl, matchesPlatformHost } from "../platforms.ts";
import { toNativePageInfo } from "../page-info.ts";

const NATIVE_NAVIGATION_READY_TIMEOUT_MS = 15_000;
const NATIVE_NAVIGATION_READY_POLL_MS = 250;
const ZHIPIN_BLOCKED_PATH_PREFIXES = ["/web/chat"] as const;

const NavigateActiveTabInputSchema = z.object({
  url: z.string().url().describe("要导航到的目标 URL"),
});

const NavigateActiveTabOutputSchema = z.object({
  success: z.boolean(),
  page: BrowserPageInfoSchema,
});

type NativePageLoadState = {
  readonly url: string;
  readonly title: string;
  readonly readyState: string;
};

type NativeNavigationTarget = {
  readonly page: BrowserInspectablePage;
  readonly platform?: Platform;
};

type NavigateActiveTabDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly getRuntime: typeof getRuntime;
  readonly detectPlatformFromUrl: typeof detectPlatformFromUrl;
  readonly matchesPlatformHost: typeof matchesPlatformHost;
  readonly toNativePageInfo: typeof toNativePageInfo;
  readonly delay: typeof delay;
};

let navigateActiveTabDepsOverride: Partial<NavigateActiveTabDeps> | undefined;

function getNavigateActiveTabDeps(): NavigateActiveTabDeps {
  return {
    getContextManager,
    getRuntime,
    detectPlatformFromUrl,
    matchesPlatformHost,
    toNativePageInfo,
    delay,
    ...navigateActiveTabDepsOverride,
  };
}

export function setNavigateActiveTabDepsForTests(
  override: Partial<NavigateActiveTabDeps> | undefined,
): void {
  navigateActiveTabDepsOverride = override;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNativePageLoadState(value: unknown): value is NativePageLoadState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["url"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["readyState"] === "string"
  );
}

function assertNavigationAllowed(url: string, platform: Platform | undefined): void {
  if (platform !== "zhipin") {
    return;
  }

  const pathname = new URL(url).pathname;
  const blockedPrefix = ZHIPIN_BLOCKED_PATH_PREFIXES.find(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (blockedPrefix === undefined) {
    return;
  }

  throw new Error(
    "navigate_active_tab 不支持直接导航 BOSS 后台聊天/推荐路径；请使用 zhipin_open_chat_page 或 zhipin_open_recommend_page。",
  );
}

async function resolveNativeNavigationTarget(
  ctxManager: BrowserContextManager,
  runtime: BrowserRuntime,
  deps: NavigateActiveTabDeps,
  url: string,
  logger: AgentContext["logger"],
): Promise<NativeNavigationTarget> {
  const inputPlatform = deps.detectPlatformFromUrl(url);
  const nativePages = await runtime.listNativePages();

  if (inputPlatform) {
    const matchedNative = nativePages.find((page) =>
      deps.matchesPlatformHost(page.url, inputPlatform),
    );
    if (matchedNative) {
      logger.info(`Reusing native ${inputPlatform} page for navigation`);
      await runtime.activateNativePage(matchedNative.targetId);
      ctxManager.rememberNativePageSelection(inputPlatform, matchedNative);
      return {
        page: matchedNative,
        platform: inputPlatform,
      };
    }

    logger.info(`Opening native ${inputPlatform} page for navigation`);
    const openedPage = await runtime.openNativePage(url);
    ctxManager.rememberNativePageSelection(inputPlatform, openedPage);
    return {
      page: openedPage,
      platform: inputPlatform,
    };
  }

  logger.info("Opening a new native page for non-platform navigation");
  return {
    page: await runtime.openNativePage(url),
  };
}

async function readNativePageLoadState(
  controller: NativeCdpController,
): Promise<NativePageLoadState> {
  const value = await controller.evaluateJson<unknown>(
    `(() => ({ url: location.href, title: document.title, readyState: document.readyState }))()`,
  );
  if (!isNativePageLoadState(value)) {
    throw new Error("Native CDP Runtime.evaluate returned an unexpected page load state.");
  }
  return value;
}

async function waitForNativePageReady(
  controller: NativeCdpController,
  deps: NavigateActiveTabDeps,
  expectedUrl: string,
  initialUrl: string,
): Promise<NativePageLoadState> {
  const startedAt = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - startedAt < NATIVE_NAVIGATION_READY_TIMEOUT_MS) {
    try {
      const state = await readNativePageLoadState(controller);
      if (
        (state.readyState === "interactive" || state.readyState === "complete") &&
        hasReachedNavigationUrl(state.url, expectedUrl, initialUrl)
      ) {
        return state;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await deps.delay(NATIVE_NAVIGATION_READY_POLL_MS);
  }

  throw new Error(
    `Native navigation did not reach document ready state within ${NATIVE_NAVIGATION_READY_TIMEOUT_MS}ms${
      lastError ? `: ${lastError.message}` : ""
    }`,
  );
}

function hasReachedNavigationUrl(
  stateUrl: string,
  expectedUrl: string,
  initialUrl: string,
): boolean {
  if (stateUrl === expectedUrl) {
    return true;
  }

  try {
    const state = new URL(stateUrl);
    if (state.protocol !== "http:" && state.protocol !== "https:") {
      return false;
    }

    return stateUrl !== initialUrl;
  } catch {
    return false;
  }
}

async function navigateNativePageIfNeeded(
  controller: NativeCdpController,
  page: BrowserInspectablePage,
  url: string,
): Promise<void> {
  if (page.url === url) {
    return;
  }

  await controller.navigate(url);
}

async function readRefreshedNativePage(
  runtime: BrowserRuntime,
  page: BrowserInspectablePage,
  state: NativePageLoadState,
): Promise<BrowserInspectablePage> {
  const refreshedPage = (await runtime.listNativePages()).find(
    (candidate) => candidate.targetId === page.targetId,
  );
  return {
    ...(refreshedPage ?? page),
    url: state.url,
    title: state.title,
  };
}

export const navigateActiveTab = defineTool({
  name: "navigate_active_tab",
  description:
    "通过 native CDP 打开或导航页面；已知平台优先复用平台 tab，不触发 Playwright attach，不直接跳转 BOSS 后台聊天/推荐路径。",
  input: NavigateActiveTabInputSchema,
  output: NavigateActiveTabOutputSchema,
  execute: async (input, ctx) => {
    const deps = getNavigateActiveTabDeps();
    const ctxManager = deps.getContextManager();
    const runtime = deps.getRuntime();
    const inputPlatform = deps.detectPlatformFromUrl(input.url);

    assertNavigationAllowed(input.url, inputPlatform);
    ctx.logger.info(`Native navigating to ${input.url}`);

    const target = await resolveNativeNavigationTarget(
      ctxManager,
      runtime,
      deps,
      input.url,
      ctx.logger,
    );
    const controller = await runtime.connectNativePage(target.page);

    try {
      await controller.bringToFront().catch(() => {});
      await navigateNativePageIfNeeded(controller, target.page, input.url);
      const loadState = await waitForNativePageReady(controller, deps, input.url, target.page.url);
      const finalPage = await readRefreshedNativePage(runtime, target.page, loadState);
      const detectedPlatform = target.platform ?? deps.detectPlatformFromUrl(finalPage.url);
      if (detectedPlatform) {
        ctxManager.rememberNativePageSelection(detectedPlatform, finalPage);
        ctx.logger.info(`Bound native navigated page to ${detectedPlatform}`);
      }

      return {
        success: true,
        page: deps.toNativePageInfo(ctxManager, finalPage) satisfies BrowserPageInfo,
      };
    } finally {
      controller.close();
    }
  },
});
