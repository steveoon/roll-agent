import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
  BrowserSecurityConfig,
  NativeCdpController,
} from "@roll-agent/browser";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { StructuredToolError } from "@roll-agent/sdk";
import { resetBrowserActionApprovalsForTests } from "../browser-action-approval.ts";
import {
  browserReloadActiveTab,
  setReloadActiveTabDepsForTests,
} from "./browser-reload-active-tab.ts";

function createTestContext(): AgentContext {
  return {
    llm: { generateText: async () => "" },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as AgentContext;
}

function createNativePage(
  targetId: string,
  url: string,
  title = "BOSS直聘",
): BrowserInspectablePage {
  return {
    targetId,
    type: "page",
    url,
    title,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${targetId}`,
  };
}

function createFakeContextManager(selected: ReadonlySet<string>): BrowserContextManager {
  return {
    isNativePageSelected(targetId: string) {
      return selected.has(targetId);
    },
    getBoundPlatformForNativePage(targetId: string) {
      return selected.has(targetId) ? "zhipin" : undefined;
    },
  } as unknown as BrowserContextManager;
}

function createFakeController(): Pick<NativeCdpController, "bringToFront" | "close"> & {
  readonly closeCalls: string[];
} {
  const closeCalls: string[] = [];
  return {
    async bringToFront() {},
    close() {
      closeCalls.push("close");
    },
    closeCalls,
  };
}

function createFakeRuntime(
  pages: readonly BrowserInspectablePage[],
  controller: { close(): void },
  security?: Partial<BrowserSecurityConfig>,
): Pick<
  BrowserRuntime,
  "getConfig" | "listNativePages" | "connectNativePage" | "getNativePageWindowState"
> & { readonly connectedTargets: string[] } {
  const connectedTargets: string[] = [];
  return {
    connectedTargets,
    getConfig() {
      return BrowserRuntimeConfigSchema.parse({ security });
    },
    async getNativePageWindowState() {
      return "normal";
    },
    async listNativePages() {
      return pages;
    },
    async connectNativePage(page: string | BrowserInspectablePage) {
      connectedTargets.push(typeof page === "string" ? page : page.targetId);
      return controller as unknown as NativeCdpController;
    },
  };
}

afterEach(() => {
  setReloadActiveTabDepsForTests(undefined);
  resetBrowserActionApprovalsForTests();
});

describe("browser_reload_active_tab", () => {
  it("reloads the single selected native page and reports reloaded", async () => {
    const controller = createFakeController();
    const pages = [createNativePage("target-boss", "https://www.zhipin.com/web/chat/index")];
    const runtime = createFakeRuntime(pages, controller);
    const reloadCalls: unknown[] = [];

    setReloadActiveTabDepsForTests({
      getContextManager: () => createFakeContextManager(new Set(["target-boss"])),
      getRuntime: () => runtime as unknown as BrowserRuntime,
      reloadNativePageAndWaitForSwap: async (_controller, options) => {
        reloadCalls.push(options);
      },
    });

    const result = await browserReloadActiveTab.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.reloaded, true);
    assert.equal(result.page.pageId, "target-boss");
    assert.deepEqual(reloadCalls, [{ url: "https://www.zhipin.com/web/chat/index" }]);
    assert.deepEqual(runtime.connectedTargets, ["target-boss"]);
    assert.equal(controller.closeCalls.length, 1);
  });

  it("forwards ignoreCache to the swap helper", async () => {
    const controller = createFakeController();
    const pages = [createNativePage("target-boss", "https://www.zhipin.com/web/chat/index")];
    const runtime = createFakeRuntime(pages, controller);
    const reloadCalls: Array<Record<string, unknown>> = [];

    setReloadActiveTabDepsForTests({
      getContextManager: () => createFakeContextManager(new Set(["target-boss"])),
      getRuntime: () => runtime as unknown as BrowserRuntime,
      reloadNativePageAndWaitForSwap: async (_controller, options) => {
        reloadCalls.push(options as Record<string, unknown>);
      },
    });

    await browserReloadActiveTab.execute({ ignoreCache: true }, createTestContext());

    assert.equal(reloadCalls[0]?.["ignoreCache"], true);
  });

  it("reloads the only native page when none is explicitly selected", async () => {
    const controller = createFakeController();
    const pages = [createNativePage("target-only", "https://www.zhipin.com/web/chat/index")];
    const runtime = createFakeRuntime(pages, controller);

    setReloadActiveTabDepsForTests({
      getContextManager: () => createFakeContextManager(new Set()),
      getRuntime: () => runtime as unknown as BrowserRuntime,
      reloadNativePageAndWaitForSwap: async () => {},
    });

    const result = await browserReloadActiveTab.execute({}, createTestContext());
    assert.equal(result.page.pageId, "target-only");
  });

  it("errors when multiple native pages are open and none selected", async () => {
    const controller = createFakeController();
    const pages = [
      createNativePage("target-a", "https://www.zhipin.com/web/chat/index"),
      createNativePage("target-b", "https://www.zhipin.com/web/boss/index"),
    ];
    const runtime = createFakeRuntime(pages, controller);

    setReloadActiveTabDepsForTests({
      getContextManager: () => createFakeContextManager(new Set()),
      getRuntime: () => runtime as unknown as BrowserRuntime,
      reloadNativePageAndWaitForSwap: async () => {},
    });

    await assert.rejects(
      browserReloadActiveTab.execute({}, createTestContext()),
      /select the target tab before reloading/,
    );
    assert.deepEqual(runtime.connectedTargets, []);
  });

  it("returns needs_confirmation under confirm policy before connecting", async () => {
    const controller = createFakeController();
    const pages = [createNativePage("target-boss", "https://www.zhipin.com/web/chat/index")];
    const runtime = createFakeRuntime(pages, controller, { actionPolicy: "confirm" });

    setReloadActiveTabDepsForTests({
      getContextManager: () => createFakeContextManager(new Set(["target-boss"])),
      getRuntime: () => runtime as unknown as BrowserRuntime,
      reloadNativePageAndWaitForSwap: async () => {},
    });

    await assert.rejects(browserReloadActiveTab.execute({}, createTestContext()), (error) => {
      assert.ok(error instanceof StructuredToolError);
      assert.equal(error.payload.code, "needs_confirmation");
      return true;
    });
    assert.deepEqual(runtime.connectedTargets, []);
    assert.equal(controller.closeCalls.length, 0);
  });
});
