import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import { StructuredToolError } from "@roll-agent/sdk";
import type { BrowserRuntime, BrowserSecurityConfig } from "@roll-agent/browser";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import type {
  ZhipinNativePagePort,
  ZhipinNativeReloadOptions,
} from "../pages/zhipin/native-page.ts";
import { resetBrowserActionApprovalsForTests } from "../browser-action-approval.ts";
import { setZhipinOpenChatPageDepsForTests, zhipinOpenChatPage } from "./zhipin-open-chat-page.ts";

function createRuntime(security?: Partial<BrowserSecurityConfig>): BrowserRuntime {
  return {
    getConfig() {
      return BrowserRuntimeConfigSchema.parse({ security });
    },
  } as unknown as BrowserRuntime;
}

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

function createNoopSession(calls: string[]) {
  return {
    async begin(label: string) {
      calls.push(`begin:${label}`);
      return true;
    },
    async highlightSelector(selector: string) {
      calls.push(`highlight:${selector}`);
      return true;
    },
    async previewMouseMotion() {},
    async succeed(label: string) {
      calls.push(`succeed:${label}`);
      return true;
    },
    async fail(label: string) {
      calls.push(`fail:${label}`);
      return true;
    },
  };
}

function createNativePage(options: {
  readonly url?: string;
  readonly alreadyOnChat?: boolean;
  readonly clickResult?: boolean;
  readonly chatReady?: boolean;
  readonly chatListReady?: boolean;
  readonly reloadError?: Error;
  readonly calls: string[];
}): ZhipinNativePagePort {
  const url =
    options.url ??
    (options.alreadyOnChat
      ? "https://www.zhipin.com/web/chat/index"
      : "https://www.zhipin.com/web/chat/recommend");
  return {
    targetId: "target-boss",
    async bringToFront() {
      options.calls.push("bring-to-front");
    },
    async url() {
      return url;
    },
    async inspectChatReloadTarget() {
      if (!url.includes("/web/chat/index")) {
        return {
          ok: false,
          url,
          skippedReason: "not_chat_page",
          error: "当前 BOSS 页面不是沟通页，已跳过 reload；请先切换到沟通页。",
        };
      }

      return { ok: true, url };
    },
    async reload(reloadOptions?: ZhipinNativeReloadOptions) {
      options.calls.push("reload");
      if (reloadOptions?.url !== undefined) {
        options.calls.push(`reload-url:${reloadOptions.url}`);
      }
      reloadOptions?.onReloadSent?.();
      if (options.reloadError !== undefined) {
        throw options.reloadError;
      }
    },
    async isChatSurfaceOpen() {
      return options.alreadyOnChat ?? false;
    },
    async clickSidebarSection(section: "chat" | "recommend") {
      options.calls.push(`click:${section}`);
      return options.clickResult ?? true;
    },
    async waitForChatSurface() {
      return options.chatReady ?? true;
    },
    async waitForChatListReady(
      readinessOptions: { readonly expectedConversationId?: string } = {},
    ) {
      options.calls.push(
        `wait-for-chat-list:${readinessOptions.expectedConversationId ?? "<any>"}`,
      );
      return options.chatListReady ?? true;
    },
    async inspectPage() {
      return {
        targetId: "target-boss",
        type: "page",
        url,
        title: "BOSS直聘",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-boss",
      };
    },
    close() {
      options.calls.push("close");
    },
  } as unknown as ZhipinNativePagePort;
}

function createContextManager() {
  return {
    getBoundPlatformForNativePage() {
      return "zhipin";
    },
    isNativePageSelected() {
      return true;
    },
  };
}

afterEach(() => {
  setZhipinOpenChatPageDepsForTests(undefined);
  resetBrowserActionApprovalsForTests();
});

describe("zhipin_open_chat_page", () => {
  it("returns success without clicking when already on the chat surface", async () => {
    const calls: string[] = [];

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      openNativePagePort: async () => createNativePage({ alreadyOnChat: true, calls }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenChatPage.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.alreadyOnChat, true);
    assert.equal(result.usedSidebarClick, false);
    assert.equal(result.chatReady, true);
    assert.deepEqual(calls, [
      "begin:正在切换到沟通页",
      "highlight:.side-wrap.side-wrap-v2",
      "succeed:已在沟通页",
      "close",
    ]);
  });

  it("clicks the sidebar chat link through native input and waits for the chat surface", async () => {
    const calls: string[] = [];

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      openNativePagePort: async () => createNativePage({ calls }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenChatPage.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.alreadyOnChat, false);
    assert.equal(result.usedSidebarClick, true);
    assert.equal(result.chatReady, true);
    assert.deepEqual(calls, [
      "begin:正在切换到沟通页",
      "highlight:.side-wrap.side-wrap-v2",
      "click:chat",
      "succeed:已切换到沟通页",
      "close",
    ]);
  });

  it("returns a structured failure when the chat nav is missing", async () => {
    const calls: string[] = [];

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      openNativePagePort: async () => createNativePage({ calls, clickResult: false }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenChatPage.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.usedSidebarClick, false);
    assert.match(result.error ?? "", /未找到沟通导航/);
    assert.deepEqual(calls, [
      "begin:正在切换到沟通页",
      "highlight:.side-wrap.side-wrap-v2",
      "click:chat",
      "fail:未找到沟通导航",
      "close",
    ]);
  });

  it("reloads the chat page instead of clicking when forceReload is set", async () => {
    const calls: string[] = [];
    let openOptions: unknown;

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      getRuntime: () => createRuntime(),
      openNativePagePort: async (options) => {
        openOptions = options;
        return createNativePage({ alreadyOnChat: true, calls });
      },
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenChatPage.execute(
      { forceReload: true, expectedConversationId: "conversation-1" },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.usedReload, true);
    assert.equal(result.alreadyOnChat, false);
    assert.equal(result.usedSidebarClick, false);
    assert.equal(result.chatReady, true);
    assert.deepEqual(openOptions, { requireChatPage: true });
    assert.deepEqual(calls, [
      "begin:正在刷新沟通页",
      "reload",
      "reload-url:https://www.zhipin.com/web/chat/index",
      "wait-for-chat-list:conversation-1",
      "succeed:已刷新沟通页",
      "close",
    ]);
  });

  it("fails reload recovery when the document swaps before the chat list is ready", async () => {
    const calls: string[] = [];

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      getRuntime: () => createRuntime(),
      openNativePagePort: async () =>
        createNativePage({ alreadyOnChat: true, chatListReady: false, calls }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenChatPage.execute({ forceReload: true }, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.usedReload, true);
    assert.equal(result.chatReady, false);
    assert.match(result.error ?? "", /刷新后沟通列表未就绪/);
    assert.deepEqual(calls, [
      "begin:正在刷新沟通页",
      "reload",
      "reload-url:https://www.zhipin.com/web/chat/index",
      "wait-for-chat-list:<any>",
      "fail:刷新后沟通列表未就绪",
      "close",
    ]);
  });

  it("skips force reload when the current page is no longer a chat URL", async () => {
    const calls: string[] = [];

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      getRuntime: () => createRuntime(),
      openNativePagePort: async () =>
        createNativePage({
          url: "https://www.zhipin.com/web/user/safe/verify",
          alreadyOnChat: false,
          calls,
        }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenChatPage.execute({ forceReload: true }, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.usedReload, false);
    assert.equal(result.chatReady, false);
    assert.equal(result.reloadSkippedReason, "not_chat_page");
    assert.match(result.error ?? "", /不是沟通页/);
    assert.ok(!calls.includes("reload"));
  });

  it("preserves usedReload when reload was sent but readiness later fails", async () => {
    const calls: string[] = [];

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      getRuntime: () => createRuntime(),
      openNativePagePort: async () =>
        createNativePage({
          alreadyOnChat: true,
          reloadError: new Error("Native page reload did not swap document within 15000ms"),
          calls,
        }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenChatPage.execute({ forceReload: true }, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.usedReload, true);
    assert.match(result.error ?? "", /did not swap document/);
  });

  it("propagates needs_confirmation without reloading under confirm policy", async () => {
    const calls: string[] = [];

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      getRuntime: () => createRuntime({ actionPolicy: "confirm" }),
      openNativePagePort: async () => createNativePage({ alreadyOnChat: true, calls }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    await assert.rejects(
      zhipinOpenChatPage.execute({ forceReload: true }, createTestContext()),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        return true;
      },
    );

    assert.ok(!calls.includes("reload"));
  });
});
