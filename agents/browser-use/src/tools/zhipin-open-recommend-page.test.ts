import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
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

function createPage(url = "https://www.zhipin.com/web/chat/index") {
  return {
    url() {
      return url;
    },
    async bringToFront() {},
  };
}

afterEach(() => {
  setZhipinOpenRecommendPageDepsForTests(undefined);
});

describe("zhipin_open_recommend_page", () => {
  it("returns success without clicking when already on the recommend surface", async () => {
    const calls: string[] = [];
    const page = createPage("https://www.zhipin.com/web/geek/recommend");

    setZhipinOpenRecommendPageDepsForTests({
      getContextManager: () =>
        ({
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            return page;
          },
        }) as never,
      isZhipinRecommendSurfaceOpen: () => true,
      getRecommendTarget: () => page as never,
      findZhipinSidebarSectionLink: async () => {
        throw new Error("sidebar lookup should not run when already on recommend");
      },
      waitForZhipinRecommendSurface: async () => true,
      createVisualActivitySession: () => ({
        async begin(label: string) {
          calls.push(`begin:${label}`);
          return true;
        },
        async highlightSelector(selector: string) {
          calls.push(`highlight:${selector}`);
          return true;
        },
        async retarget() {
          calls.push("retarget");
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

    const result = await zhipinOpenRecommendPage.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.alreadyOnRecommend, true);
    assert.equal(result.usedSidebarClick, false);
    assert.equal(result.recommendReady, true);
    assert.deepEqual(calls, [
      "begin:正在切换到推荐牛人页",
      "highlight:.side-wrap.side-wrap-v2",
      "retarget",
      "succeed:已在推荐牛人页",
    ]);
  });

  it("clicks the sidebar recommend link and waits for the recommend surface", async () => {
    const calls: string[] = [];
    const page = createPage();
    const recommendTarget = { kind: "recommend-frame" };
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

    setZhipinOpenRecommendPageDepsForTests({
      getContextManager: () =>
        ({
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            return page;
          },
        }) as never,
      isZhipinRecommendSurfaceOpen: () => false,
      getRecommendTarget: () => recommendTarget as never,
      findZhipinSidebarSectionLink: async (_page, section) => {
        assert.equal(section, "recommend");
        return link as never;
      },
      waitForZhipinRecommendSurface: async () => true,
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
        async retarget(target: unknown) {
          calls.push(`retarget:${target === recommendTarget ? "recommend" : "other"}`);
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
        url: "https://www.zhipin.com/web/geek/recommend",
        title: "BOSS直聘",
        boundPlatform: "zhipin",
        detectedPlatform: "zhipin",
        isSelectedForPlatform: true,
      }),
    });

    const result = await zhipinOpenRecommendPage.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.alreadyOnRecommend, false);
    assert.equal(result.usedSidebarClick, true);
    assert.equal(result.recommendReady, true);
    assert.deepEqual(calls, [
      "begin:正在切换到推荐牛人页",
      "highlight:.side-wrap.side-wrap-v2",
      "scroll",
      "move-cursor",
      "hover",
      "random-delay",
      "show-click",
      "click",
      "retarget:recommend",
      "succeed:已切换到推荐牛人页",
    ]);
  });

  it("returns a structured failure when the sidebar nav is missing", async () => {
    const calls: string[] = [];
    const page = createPage();

    setZhipinOpenRecommendPageDepsForTests({
      getContextManager: () =>
        ({
          async getPage() {
            return page;
          },
        }) as never,
      isZhipinRecommendSurfaceOpen: () => false,
      getRecommendTarget: () => page as never,
      findZhipinSidebarSectionLink: async () => null,
      waitForZhipinRecommendSurface: async () => false,
      createVisualActivitySession: () => ({
        async begin(label: string) {
          calls.push(`begin:${label}`);
          return true;
        },
        async highlightSelector(selector: string) {
          calls.push(`highlight:${selector}`);
          return true;
        },
        async retarget() {
          calls.push("retarget");
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

    const result = await zhipinOpenRecommendPage.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.usedSidebarClick, false);
    assert.match(result.error ?? "", /未找到推荐牛人导航/);
    assert.deepEqual(calls, [
      "begin:正在切换到推荐牛人页",
      "highlight:.side-wrap.side-wrap-v2",
      "fail:未找到推荐牛人导航",
    ]);
  });
});
