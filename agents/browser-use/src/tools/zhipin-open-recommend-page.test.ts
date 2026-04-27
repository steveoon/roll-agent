import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  setZhipinOpenRecommendPageDepsForTests,
  zhipinOpenRecommendPage,
} from "./zhipin-open-recommend-page.ts";

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
  readonly alreadyOnRecommend?: boolean;
  readonly clickResult?: boolean;
  readonly recommendReady?: boolean;
  readonly calls: string[];
}): ZhipinNativePagePort {
  return {
    targetId: "target-boss",
    async bringToFront() {
      options.calls.push("bring-to-front");
    },
    async isRecommendSurfaceOpen() {
      return options.alreadyOnRecommend ?? false;
    },
    async clickSidebarSection(section: "chat" | "recommend") {
      options.calls.push(`click:${section}`);
      return options.clickResult ?? true;
    },
    async waitForRecommendSurface() {
      return options.recommendReady ?? true;
    },
    async inspectPage() {
      return {
        targetId: "target-boss",
        type: "page",
        url: options.alreadyOnRecommend
          ? "https://www.zhipin.com/web/chat/recommend"
          : "https://www.zhipin.com/web/chat/index",
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
  setZhipinOpenRecommendPageDepsForTests(undefined);
});

describe("zhipin_open_recommend_page", () => {
  it("returns success without clicking when already on the recommend surface", async () => {
    const calls: string[] = [];

    setZhipinOpenRecommendPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      openNativePagePort: async () => createNativePage({ alreadyOnRecommend: true, calls }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenRecommendPage.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.alreadyOnRecommend, true);
    assert.equal(result.usedSidebarClick, false);
    assert.equal(result.recommendReady, true);
    assert.deepEqual(calls, [
      "bring-to-front",
      "begin:正在切换到推荐牛人页",
      "highlight:.side-wrap.side-wrap-v2",
      "succeed:已在推荐牛人页",
      "close",
    ]);
  });

  it("clicks the sidebar recommend link through native input", async () => {
    const calls: string[] = [];

    setZhipinOpenRecommendPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      openNativePagePort: async () => createNativePage({ calls }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenRecommendPage.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.alreadyOnRecommend, false);
    assert.equal(result.usedSidebarClick, true);
    assert.equal(result.recommendReady, true);
    assert.deepEqual(calls, [
      "bring-to-front",
      "begin:正在切换到推荐牛人页",
      "highlight:.side-wrap.side-wrap-v2",
      "click:recommend",
      "succeed:已切换到推荐牛人页",
      "close",
    ]);
  });

  it("returns a structured failure when the sidebar nav is missing", async () => {
    const calls: string[] = [];

    setZhipinOpenRecommendPageDepsForTests({
      getContextManager: () => createContextManager() as never,
      openNativePagePort: async () => createNativePage({ calls, clickResult: false }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenRecommendPage.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.usedSidebarClick, false);
    assert.match(result.error ?? "", /未找到推荐牛人导航/);
    assert.deepEqual(calls, [
      "bring-to-front",
      "begin:正在切换到推荐牛人页",
      "highlight:.side-wrap.side-wrap-v2",
      "click:recommend",
      "fail:未找到推荐牛人导航",
      "close",
    ]);
  });
});
