import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContextManager, BrowserInspectablePage, BrowserRuntime, Page } from "@roll-agent/browser";
import { findTrackedPlatformPage, openPlatformHomeTarget } from "./platform-page.ts";

function createInspectablePage(params: {
  targetId: string;
  url: string;
  title?: string;
}): BrowserInspectablePage {
  return {
    targetId: params.targetId,
    type: "page",
    url: params.url,
    title: params.title ?? "",
  };
}

test("openPlatformHomeTarget reuses an existing native platform page", async () => {
  const activatedTargets: string[] = [];
  let openCalls = 0;

  const runtime = {
    async listNativePages() {
      return [
        createInspectablePage({
          targetId: "target-zhipin",
          url: "https://www.zhipin.com/web/geek/chat",
          title: "BOSS直聘",
        }),
      ];
    },
    async activateNativePage(targetId: string) {
      activatedTargets.push(targetId);
    },
    async openNativePage() {
      openCalls += 1;
      throw new Error("openNativePage should not be called");
    },
  } as unknown as BrowserRuntime;

  const result = await openPlatformHomeTarget(runtime, "zhipin");

  assert.equal(result.reusedExistingPage, true);
  assert.equal(result.page.targetId, "target-zhipin");
  assert.deepEqual(activatedTargets, ["target-zhipin"]);
  assert.equal(openCalls, 0);
});

test("openPlatformHomeTarget opens the platform homepage when no native page exists", async () => {
  let openCalls = 0;

  const runtime = {
    async listNativePages() {
      return [];
    },
    async activateNativePage() {
      throw new Error("activateNativePage should not be called");
    },
    async openNativePage(url: string) {
      openCalls += 1;
      assert.equal(url, "https://www.zhipin.com");
      return createInspectablePage({
        targetId: "target-new",
        url,
        title: "BOSS直聘",
      });
    },
  } as unknown as BrowserRuntime;

  const result = await openPlatformHomeTarget(runtime, "zhipin");

  assert.equal(result.reusedExistingPage, false);
  assert.equal(result.page.targetId, "target-new");
  assert.equal(openCalls, 1);
});

test("findTrackedPlatformPage delegates to the tracked-page selection path", async () => {
  const trackedPage = {
    url() {
      return "https://www.zhipin.com/web/geek/chat";
    },
  } as unknown as Page;
  let predicateResult = false;

  const ctxManager = {
    async useTrackedPage(
      platform: string,
      predicate: (page: Page) => boolean,
    ) {
      assert.equal(platform, "zhipin");
      predicateResult = predicate(trackedPage);
      return trackedPage;
    },
  } as unknown as BrowserContextManager;

  const page = await findTrackedPlatformPage(ctxManager, "zhipin");

  assert.equal(page, trackedPage);
  assert.equal(predicateResult, true);
});
