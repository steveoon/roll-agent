import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
  BrowserSecurityConfig,
  NativeCdpController,
  NativeCdpWindowState,
} from "@roll-agent/browser";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { StructuredToolError } from "@roll-agent/sdk";
import { resetBrowserActionApprovalsForTests } from "../browser-action-approval.ts";
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
  | "getConfig"
  | "listNativePages"
  | "activateNativePage"
  | "openNativePage"
  | "connectNativePage"
  | "getNativePageWindowState"
> & {
  readonly activatedTargets: readonly string[];
  readonly openedUrls: readonly string[];
  readonly connectedTargets: readonly string[];
  readonly connectedOptions: readonly unknown[];
  readonly windowStateQueries: readonly string[];
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

function readApprovalIdFromError(error: unknown): string {
  assert.ok(error instanceof StructuredToolError);
  const details = error.payload.details;
  assert.ok(details !== undefined);
  const approvalRequest = details["approvalRequest"];
  assert.equal(typeof approvalRequest, "object");
  assert.notEqual(approvalRequest, null);
  assert.equal(typeof (approvalRequest as Record<string, unknown>)["id"], "string");
  return (approvalRequest as { id: string }).id;
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
  security?: Partial<BrowserSecurityConfig>,
  windowState: NativeCdpWindowState = "normal",
): FakeRuntime {
  const activatedTargets: string[] = [];
  const openedUrls: string[] = [];
  const connectedTargets: string[] = [];
  const connectedOptions: unknown[] = [];
  const windowStateQueries: string[] = [];
  const pages = [...initialPages];

  return {
    activatedTargets,
    openedUrls,
    connectedTargets,
    connectedOptions,
    windowStateQueries,
    getConfig() {
      return BrowserRuntimeConfigSchema.parse({ security });
    },
    async getNativePageWindowState(targetId: string) {
      windowStateQueries.push(targetId);
      return windowState;
    },
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
    async connectNativePage(page: string | BrowserInspectablePage, options?: unknown) {
      const targetId = typeof page === "string" ? page : page.targetId;
      connectedTargets.push(targetId);
      connectedOptions.push(options);
      return controller as unknown as NativeCdpController;
    },
  };
}

afterEach(() => {
  setNavigateActiveTabDepsForTests(undefined);
  resetBrowserActionApprovalsForTests();
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
    assert.deepEqual(runtime.windowStateQueries, ["target-boss"]);
    assert.deepEqual(controller.navigateCalls, ["https://www.zhipin.com/web/user/index"]);
    assert.equal(controller.bringToFrontCalls.length, 0);
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
    assert.deepEqual(runtime.windowStateQueries, ["target-boss"]);
    assert.equal(controller.bringToFrontCalls.length, 0);
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

  it("denies navigation outside domainAllowlist before CDP calls", async () => {
    const controller = createFakeController([]);
    const runtime = createFakeRuntime([], controller, {
      domainAllowlist: ["zhipin.com"],
    });
    const ctxManager = createFakeContextManager();

    setNavigateActiveTabDepsForTests({
      getContextManager: () => ctxManager,
      getRuntime: () => runtime as unknown as BrowserRuntime,
      delay: immediateDelay,
    });

    await assert.rejects(
      navigateActiveTab.execute({ url: "https://evilzhipin.com" }, createTestContext()),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "action_denied");
        assert.match(error.payload.message, /domainAllowlist/);
        return true;
      },
    );

    assert.deepEqual(runtime.openedUrls, []);
    assert.deepEqual(runtime.activatedTargets, []);
    assert.deepEqual(runtime.connectedTargets, []);
    assert.equal(controller.closeCalls.length, 0);
  });

  it("returns needs_confirmation for confirm action policy before CDP calls", async () => {
    const controller = createFakeController([]);
    const runtime = createFakeRuntime([], controller, {
      actionPolicy: "confirm",
    });
    const ctxManager = createFakeContextManager();

    setNavigateActiveTabDepsForTests({
      getContextManager: () => ctxManager,
      getRuntime: () => runtime as unknown as BrowserRuntime,
      delay: immediateDelay,
    });

    await assert.rejects(
      navigateActiveTab.execute({ url: "https://example.com" }, createTestContext()),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        assert.match(error.payload.message, /requires confirmation/);
        assert.equal(typeof error.payload.details?.["approvalRequest"], "object");
        return true;
      },
    );

    assert.deepEqual(runtime.openedUrls, []);
    assert.deepEqual(runtime.activatedTargets, []);
    assert.deepEqual(runtime.connectedTargets, []);
    assert.equal(controller.closeCalls.length, 0);
  });

  it("executes confirm-gated navigation when retried with matching approval", async () => {
    const controller = createFakeController([
      {
        url: "https://example.com/dashboard",
        title: "Example",
        readyState: "complete",
      },
    ]);
    const runtime = createFakeRuntime([], controller, {
      actionPolicy: "confirm",
    });
    const ctxManager = createFakeContextManager();

    setNavigateActiveTabDepsForTests({
      getContextManager: () => ctxManager,
      getRuntime: () => runtime as unknown as BrowserRuntime,
      delay: immediateDelay,
    });

    let approvalId = "";
    await assert.rejects(
      navigateActiveTab.execute({ url: "https://example.com/dashboard" }, createTestContext()),
      (error) => {
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );

    const result = await navigateActiveTab.execute(
      {
        url: "https://example.com/dashboard",
        browserActionApproval: { id: approvalId },
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(runtime.openedUrls, ["https://example.com/dashboard"]);
    assert.deepEqual(runtime.connectedTargets, ["target-opened-1"]);
    assert.equal(controller.closeCalls.length, 1);
  });
});
