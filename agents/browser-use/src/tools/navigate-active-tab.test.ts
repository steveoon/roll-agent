import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import {
  navigateActiveTab,
  setNavigateActiveTabDepsForTests,
} from "./navigate-active-tab.ts";

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

function createPage(url: string) {
  let currentUrl = url;
  let gotoCalls = 0;
  let bringToFrontCalls = 0;

  return {
    page: {
      url() {
        return currentUrl;
      },
      async goto(nextUrl: string) {
        gotoCalls += 1;
        currentUrl = nextUrl;
      },
      async bringToFront() {
        bringToFrontCalls += 1;
      },
    },
    getGotoCalls: () => gotoCalls,
    getBringToFrontCalls: () => bringToFrontCalls,
  };
}

afterEach(() => {
  setNavigateActiveTabDepsForTests(undefined);
});

describe("navigate_active_tab", () => {
  it("reuses an already tracked Boss page instead of navigating the current unrelated tab", async () => {
    const tracked = createPage("https://www.zhipin.com/web/chat/index");
    let getActivePageCalls = 0;
    let selectAttachedPageCalls = 0;

    setNavigateActiveTabDepsForTests({
      getContextManager: () =>
        ({
          async getActivePage() {
            getActivePageCalls += 1;
            throw new Error("getActivePage should not be used when a tracked Boss page exists");
          },
          async listNativePages() {
            return [];
          },
          async selectNativePage() {
            throw new Error("selectNativePage should not be used when a tracked Boss page exists");
          },
          async getPage() {
            throw new Error("getPage should not be used when a tracked Boss page exists");
          },
          async selectAttachedPage(platform: string, pageId: string) {
            assert.equal(platform, "zhipin");
            assert.equal(pageId, "page-boss");
            selectAttachedPageCalls += 1;
            return tracked.page as never;
          },
          getPageId() {
            return "page-boss";
          },
          clearBindingForPage() {},
        }) as never,
      findTrackedPlatformPage: async () => tracked.page as never,
      toAttachedPageInfo: async () => ({
        pageId: "page-boss",
        url: tracked.page.url(),
        title: "BOSS直聘",
        boundPlatform: "zhipin",
        detectedPlatform: "zhipin",
        isSelectedForPlatform: true,
      }),
    });

    const result = await navigateActiveTab.execute(
      { url: "https://www.zhipin.com/web/chat/index" },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(getActivePageCalls, 0);
    assert.equal(tracked.getGotoCalls(), 0);
    assert.equal(tracked.getBringToFrontCalls(), 1);
    assert.equal(selectAttachedPageCalls, 1);
  });

  it("reuses an existing native Boss page before falling back to the active tab", async () => {
    const attachedBoss = createPage("https://www.zhipin.com/web/chat/recommend");
    let getActivePageCalls = 0;
    const nativeSelections: string[] = [];
    const attachedSelections: Array<{ platform: string; pageId: string }> = [];

    setNavigateActiveTabDepsForTests({
      getContextManager: () =>
        ({
          async getActivePage() {
            getActivePageCalls += 1;
            throw new Error("getActivePage should not be used when a native Boss page exists");
          },
          async listNativePages() {
            return [
              {
                targetId: "target-boss",
                type: "page",
                url: "https://www.zhipin.com/web/chat/recommend",
                title: "BOSS直聘",
              },
            ];
          },
          async selectNativePage(platform: string, pageId: string) {
            nativeSelections.push(`${platform}:${pageId}`);
            return {
              targetId: pageId,
              type: "page",
              url: "https://www.zhipin.com/web/chat/recommend",
              title: "BOSS直聘",
            } as never;
          },
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            return attachedBoss.page as never;
          },
          async selectAttachedPage(platform: string, pageId: string) {
            attachedSelections.push({ platform, pageId });
            return attachedBoss.page as never;
          },
          getPageId() {
            return "page-boss";
          },
          clearBindingForPage() {},
        }) as never,
      findTrackedPlatformPage: async () => undefined,
      toAttachedPageInfo: async () => ({
        pageId: "page-boss",
        url: attachedBoss.page.url(),
        title: "BOSS直聘",
        boundPlatform: "zhipin",
        detectedPlatform: "zhipin",
        isSelectedForPlatform: true,
      }),
    });

    const result = await navigateActiveTab.execute(
      { url: "https://www.zhipin.com/web/chat/index" },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(getActivePageCalls, 0);
    assert.deepEqual(nativeSelections, ["zhipin:target-boss"]);
    assert.deepEqual(attachedSelections, [{ platform: "zhipin", pageId: "page-boss" }]);
    assert.equal(attachedBoss.getGotoCalls(), 1);
    assert.equal(attachedBoss.getBringToFrontCalls(), 1);
  });

  it("falls back to the current active tab when the URL is not a known platform", async () => {
    const active = createPage("https://example.com");
    let clearBindingCalls = 0;

    setNavigateActiveTabDepsForTests({
      getContextManager: () =>
        ({
          async getActivePage() {
            return active.page as never;
          },
          async listNativePages() {
            return [];
          },
          async selectNativePage() {
            throw new Error("selectNativePage should not be used for non-platform URLs");
          },
          async getPage() {
            throw new Error("getPage should not be used for non-platform URLs");
          },
          async selectAttachedPage() {
            throw new Error("selectAttachedPage should not be used for non-platform URLs");
          },
          getPageId() {
            return "page-active";
          },
          clearBindingForPage() {
            clearBindingCalls += 1;
          },
        }) as never,
      toAttachedPageInfo: async () => ({
        pageId: "page-active",
        url: active.page.url(),
        title: "Example",
        boundPlatform: null,
        detectedPlatform: null,
        isSelectedForPlatform: false,
      }),
    });

    const result = await navigateActiveTab.execute(
      { url: "https://example.com/dashboard" },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(active.getGotoCalls(), 1);
    assert.equal(active.getBringToFrontCalls(), 1);
    assert.equal(clearBindingCalls, 1);
  });
});
