import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
  NativeCdpController,
} from "@roll-agent/browser";
import { navigateActiveTab, setNavigateActiveTabDepsForTests } from "./navigate-active-tab.ts";

type NativeLoadState = {
  readonly url: string;
  readonly title: string;
  readonly readyState: string;
};

type DelayFunction = typeof import("node:timers/promises").setTimeout;

type FakeNativeController = Pick<
  NativeCdpController,
  "bringToFront" | "navigate" | "evaluateJson" | "close"
> & {
  readonly bringToFrontCalls: readonly string[];
  readonly navigateCalls: readonly string[];
  readonly evaluateCalls: readonly string[];
  readonly closeCalls: readonly string[];
};

type FakeRuntime = Pick<
  BrowserRuntime,
  "listNativePages" | "activateNativePage" | "openNativePage" | "connectNativePage"
> & {
  readonly activatedTargets: readonly string[];
  readonly openedUrls: readonly string[];
  readonly connectedTargets: readonly string[];
};

function createTestContext(): AgentContext {
  return {
    llm: {
      generateText: async () => "",
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

const immediateDelay: DelayFunction = async <T = void>(_delay?: number, value?: T): Promise<T> =>
  value as T;

function createNativePage(targetId: string, url: string, title = ""): BrowserInspectablePage {
  return {
    targetId,
    type: "page",
    url,
    title,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${targetId}`,
  };
}

function createFakeContextManager(): BrowserContextManager {
  const bindings = new Map<string, "zhipin" | "yupao">();

  return {
    rememberNativePageSelection(platform: "zhipin" | "yupao", page: BrowserInspectablePage) {
      bindings.set(page.targetId, platform);
    },
    getBoundPlatformForNativePage(targetId: string) {
      return bindings.get(targetId);
    },
    isNativePageSelected(targetId: string) {
      return bindings.has(targetId);
    },
  } as unknown as BrowserContextManager;
}

function createFakeController(loadStates: readonly NativeLoadState[]): FakeNativeController {
  const bringToFrontCalls: string[] = [];
  const navigateCalls: string[] = [];
  const evaluateCalls: string[] = [];
  const closeCalls: string[] = [];
  let nextLoadStateIndex = 0;

  return {
    bringToFrontCalls,
    navigateCalls,
    evaluateCalls,
    closeCalls,
    async bringToFront() {
      bringToFrontCalls.push("bringToFront");
    },
    async navigate(url: string) {
      navigateCalls.push(url);
      return {
        frameId: "main-frame",
        loaderId: "loader-1",
      };
    },
    async evaluateJson<T>(expression: string): Promise<T> {
      evaluateCalls.push(expression);
      const state = loadStates[nextLoadStateIndex] ?? loadStates[loadStates.length - 1];
      if (!state) {
        throw new Error("No fake native load state configured.");
      }
      nextLoadStateIndex += 1;
      return state as T;
    },
    close() {
      closeCalls.push("close");
    },
  };
}

function createFakeRuntime(
  initialPages: readonly BrowserInspectablePage[],
  controller: FakeNativeController,
): FakeRuntime {
  const activatedTargets: string[] = [];
  const openedUrls: string[] = [];
  const connectedTargets: string[] = [];
  const pages = [...initialPages];

  return {
    activatedTargets,
    openedUrls,
    connectedTargets,
    async listNativePages() {
      return pages;
    },
    async activateNativePage(targetId: string) {
      activatedTargets.push(targetId);
    },
    async openNativePage(url: string) {
      openedUrls.push(url);
      const page = createNativePage(`target-opened-${openedUrls.length}`, url, "");
      pages.push(page);
      return page;
    },
    async connectNativePage(page: string | BrowserInspectablePage) {
      const targetId = typeof page === "string" ? page : page.targetId;
      connectedTargets.push(targetId);
      return controller as unknown as NativeCdpController;
    },
  };
}

afterEach(() => {
  setNavigateActiveTabDepsForTests(undefined);
});

describe("navigate_active_tab", () => {
  it("reuses an existing native platform target without Playwright Page attach", async () => {
    const controller = createFakeController([
      {
        url: "https://www.zhipin.com/",
        title: "BOSS直聘",
        readyState: "complete",
      },
      {
        url: "https://www.zhipin.com/web/user/index",
        title: "BOSS后台",
        readyState: "complete",
      },
    ]);
    const runtime = createFakeRuntime(
      [createNativePage("target-boss", "https://www.zhipin.com/", "BOSS直聘")],
      controller,
    );
    const ctxManager = createFakeContextManager();

    setNavigateActiveTabDepsForTests({
      getContextManager: () => ctxManager,
      getRuntime: () => runtime as unknown as BrowserRuntime,
      delay: immediateDelay,
    });

    const result = await navigateActiveTab.execute(
      { url: "https://www.zhipin.com/web/user/index" },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.page.pageId, "target-boss");
    assert.equal(result.page.url, "https://www.zhipin.com/web/user/index");
    assert.equal(result.page.boundPlatform, "zhipin");
    assert.deepEqual(runtime.activatedTargets, ["target-boss"]);
    assert.deepEqual(runtime.connectedTargets, ["target-boss"]);
    assert.deepEqual(controller.navigateCalls, ["https://www.zhipin.com/web/user/index"]);
    assert.equal(controller.bringToFrontCalls.length, 1);
    assert.equal(controller.evaluateCalls.length, 2);
    assert.equal(controller.closeCalls.length, 1);
  });

  it("opens a new native page for non-platform URLs instead of resolving an attached active page", async () => {
    const controller = createFakeController([
      {
        url: "https://example.com/dashboard",
        title: "Example",
        readyState: "complete",
      },
    ]);
    const runtime = createFakeRuntime(
      [createNativePage("target-boss", "https://www.zhipin.com/", "BOSS直聘")],
      controller,
    );
    const ctxManager = createFakeContextManager();

    setNavigateActiveTabDepsForTests({
      getContextManager: () => ctxManager,
      getRuntime: () => runtime as unknown as BrowserRuntime,
      delay: immediateDelay,
    });

    const result = await navigateActiveTab.execute(
      { url: "https://example.com/dashboard" },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.page.pageId, "target-opened-1");
    assert.equal(result.page.boundPlatform, null);
    assert.deepEqual(runtime.openedUrls, ["https://example.com/dashboard"]);
    assert.deepEqual(runtime.activatedTargets, []);
    assert.deepEqual(runtime.connectedTargets, ["target-opened-1"]);
    assert.deepEqual(controller.navigateCalls, []);
    assert.equal(controller.closeCalls.length, 1);
  });

  it("does not send Page.navigate when the native target already has the requested URL", async () => {
    const controller = createFakeController([
      {
        url: "https://www.zhipin.com/",
        title: "BOSS直聘",
        readyState: "interactive",
      },
    ]);
    const runtime = createFakeRuntime(
      [createNativePage("target-boss", "https://www.zhipin.com/", "BOSS直聘")],
      controller,
    );
    const ctxManager = createFakeContextManager();

    setNavigateActiveTabDepsForTests({
      getContextManager: () => ctxManager,
      getRuntime: () => runtime as unknown as BrowserRuntime,
      delay: immediateDelay,
    });

    const result = await navigateActiveTab.execute(
      { url: "https://www.zhipin.com/" },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(controller.navigateCalls, []);
    assert.equal(controller.bringToFrontCalls.length, 1);
    assert.equal(controller.evaluateCalls.length, 1);
  });

  it("rejects direct navigation to BOSS chat and recommend backend paths before CDP calls", async () => {
    const controller = createFakeController([]);
    const runtime = createFakeRuntime([], controller);
    const ctxManager = createFakeContextManager();

    setNavigateActiveTabDepsForTests({
      getContextManager: () => ctxManager,
      getRuntime: () => runtime as unknown as BrowserRuntime,
      delay: immediateDelay,
    });

    await assert.rejects(
      navigateActiveTab.execute(
        { url: "https://www.zhipin.com/web/chat/recommend" },
        createTestContext(),
      ),
      /不支持直接导航 BOSS 后台聊天\/推荐路径/,
    );

    assert.deepEqual(runtime.openedUrls, []);
    assert.deepEqual(runtime.activatedTargets, []);
    assert.deepEqual(runtime.connectedTargets, []);
    assert.equal(controller.closeCalls.length, 0);
  });
});
