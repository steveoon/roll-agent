import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import {
  setZhipinOpenChatPageDepsForTests,
  zhipinOpenChatPage,
} from "./zhipin-open-chat-page.ts";

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

function createPage(url = "https://www.zhipin.com/web/geek/recommend") {
  return {
    url() {
      return url;
    },
    async bringToFront() {},
  };
}

afterEach(() => {
  setZhipinOpenChatPageDepsForTests(undefined);
});

describe("zhipin_open_chat_page", () => {
  it("returns success without clicking when already on the chat surface", async () => {
    const calls: string[] = [];
    const page = createPage("https://www.zhipin.com/web/chat/index");

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () =>
        ({
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            return page;
          },
        }) as never,
      isZhipinChatSurfaceOpen: async () => true,
      findZhipinSidebarSectionLink: async () => {
        throw new Error("sidebar lookup should not run when already on chat");
      },
      waitForZhipinChatSurface: async () => true,
      createVisualActivitySession: () => ({
        async begin(label: string) {
          calls.push(`begin:${label}`);
          return true;
        },
        async highlightSelector(selector: string) {
          calls.push(`highlight:${selector}`);
          return true;
        },
        async succeed(label: string) {
          calls.push(`succeed:${label}`);
          return true;
        },
        async fail(label: string) {
          calls.push(`fail:${label}`);
          return true;
        },
      }),
      toAttachedPageInfo: async () => ({
        pageId: "page-boss",
        url: page.url(),
        title: "BOSS直聘",
        boundPlatform: "zhipin",
        detectedPlatform: "zhipin",
        isSelectedForPlatform: true,
      }),
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
    ]);
  });

  it("clicks the sidebar chat link and waits for the chat surface", async () => {
    const calls: string[] = [];
    const page = createPage();
    const link = {
      async scrollIntoViewIfNeeded() {
        calls.push("scroll");
      },
      async hover() {
        calls.push("hover");
      },
      async click() {
        calls.push("click");
      },
    };

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () =>
        ({
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            return page;
          },
        }) as never,
      isZhipinChatSurfaceOpen: async () => false,
      findZhipinSidebarSectionLink: async (_page, section) => {
        assert.equal(section, "chat");
        return link as never;
      },
      waitForZhipinChatSurface: async () => true,
      moveVisualCursorToLocator: async () => {
        calls.push("move-cursor");
        return true;
      },
      showVisualClickOnLocator: async () => {
        calls.push("show-click");
        return true;
      },
      randomDelay: async () => {
        calls.push("random-delay");
      },
      createVisualActivitySession: () => ({
        async begin(label: string) {
          calls.push(`begin:${label}`);
          return true;
        },
        async highlightSelector(selector: string) {
          calls.push(`highlight:${selector}`);
          return true;
        },
        async succeed(label: string) {
          calls.push(`succeed:${label}`);
          return true;
        },
        async fail(label: string) {
          calls.push(`fail:${label}`);
          return true;
        },
      }),
      toAttachedPageInfo: async () => ({
        pageId: "page-boss",
        url: "https://www.zhipin.com/web/chat/index",
        title: "BOSS直聘",
        boundPlatform: "zhipin",
        detectedPlatform: "zhipin",
        isSelectedForPlatform: true,
      }),
    });

    const result = await zhipinOpenChatPage.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.alreadyOnChat, false);
    assert.equal(result.usedSidebarClick, true);
    assert.equal(result.chatReady, true);
    assert.deepEqual(calls, [
      "begin:正在切换到沟通页",
      "highlight:.side-wrap.side-wrap-v2",
      "scroll",
      "move-cursor",
      "hover",
      "random-delay",
      "show-click",
      "click",
      "succeed:已切换到沟通页",
    ]);
  });

  it("returns a structured failure when the chat nav is missing", async () => {
    const calls: string[] = [];
    const page = createPage();

    setZhipinOpenChatPageDepsForTests({
      getContextManager: () =>
        ({
          async getPage() {
            return page;
          },
        }) as never,
      isZhipinChatSurfaceOpen: async () => false,
      findZhipinSidebarSectionLink: async () => null,
      waitForZhipinChatSurface: async () => false,
      createVisualActivitySession: () => ({
        async begin(label: string) {
          calls.push(`begin:${label}`);
          return true;
        },
        async highlightSelector(selector: string) {
          calls.push(`highlight:${selector}`);
          return true;
        },
        async succeed(label: string) {
          calls.push(`succeed:${label}`);
          return true;
        },
        async fail(label: string) {
          calls.push(`fail:${label}`);
          return true;
        },
      }),
      toAttachedPageInfo: async () => ({
        pageId: "page-boss",
        url: page.url(),
        title: "BOSS直聘",
        boundPlatform: "zhipin",
        detectedPlatform: "zhipin",
        isSelectedForPlatform: true,
      }),
    });

    const result = await zhipinOpenChatPage.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.usedSidebarClick, false);
    assert.match(result.error ?? "", /未找到沟通导航/);
    assert.deepEqual(calls, [
      "begin:正在切换到沟通页",
      "highlight:.side-wrap.side-wrap-v2",
      "fail:未找到沟通导航",
    ]);
  });
});
