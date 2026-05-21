import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { setZhipinOpenChatPageDepsForTests, zhipinOpenChatPage } from "./zhipin-open-chat-page.ts";

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
  readonly alreadyOnChat?: boolean;
  readonly clickResult?: boolean;
  readonly chatReady?: boolean;
  readonly calls: string[];
}): ZhipinNativePagePort {
  return {
    targetId: "target-boss",
    async bringToFront() {
      options.calls.push("bring-to-front");
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
    async inspectPage() {
      return {
        targetId: "target-boss",
        type: "page",
        url: options.alreadyOnChat
          ? "https://www.zhipin.com/web/chat/index"
          : "https://www.zhipin.com/web/chat/recommend",
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
});
