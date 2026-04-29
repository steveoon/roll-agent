import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { DynamicListScrollResult } from "../pages/shared/dynamic-list-scroller.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { setZhipinScrollViewDepsForTests, zhipinScrollView } from "./zhipin-scroll-view.ts";

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

function createNoopSession() {
  return {
    async begin() {
      return true;
    },
    async highlightSelector() {
      return true;
    },
    async succeed() {
      return true;
    },
    async fail() {
      return true;
    },
  };
}

afterEach(() => {
  setZhipinScrollViewDepsForTests(undefined);
});

describe("zhipin_scroll_view", () => {
  it("defaults to a single bounded scroll step", () => {
    const parsed = zhipinScrollView.input.parse({ surface: "chat-list" });

    assert.equal(parsed.surface, "chat-list");
    assert.equal(parsed.steps, 1);
    assert.equal(parsed.settleMs, 700);
  });

  it("allows zero-step boundary inspection", () => {
    const parsed = zhipinScrollView.input.parse({ surface: "chat-list", steps: 0 });

    assert.equal(parsed.steps, 0);
  });

  it("returns top-level boundary state for orchestrators", async () => {
    const scrollResult: DynamicListScrollResult = {
      success: true,
      direction: "down",
      stepsRequested: 0,
      stepsCompleted: 0,
      reachedBoundary: false,
      before: {
        containerFound: true,
        containerLabel: "user-list.b-scroll-stable",
        scrollTop: 120,
        scrollHeight: 1_000,
        clientHeight: 400,
        itemCount: 20,
        atStart: false,
        atEnd: false,
      },
      after: {
        containerFound: true,
        containerLabel: "user-list.b-scroll-stable",
        scrollTop: 120,
        scrollHeight: 1_000,
        clientHeight: 400,
        itemCount: 20,
        atStart: false,
        atEnd: false,
      },
    };

    setZhipinScrollViewDepsForTests({
      openNativePagePort: async () =>
        ({
          async scrollSurface() {
            return scrollResult;
          },
          close() {},
        }) as unknown as ZhipinNativePagePort,
      createNativeVisualActivitySession: createNoopSession,
    });

    const result = await zhipinScrollView.execute(
      { surface: "chat-list", steps: 0, settleMs: 0 },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.atTop, false);
    assert.equal(result.atBottom, false);
    assert.equal(result.canScrollUp, true);
    assert.equal(result.canScrollDown, true);
    assert.equal(result.position, "middle");
  });

  it("marks a single-page list as both top and bottom", async () => {
    const scrollResult: DynamicListScrollResult = {
      success: true,
      direction: "down",
      stepsRequested: 0,
      stepsCompleted: 0,
      reachedBoundary: true,
      before: {
        containerFound: true,
        containerLabel: "user-list.b-scroll-stable",
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 400,
        itemCount: 4,
        atStart: true,
        atEnd: true,
      },
      after: {
        containerFound: true,
        containerLabel: "user-list.b-scroll-stable",
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 400,
        itemCount: 4,
        atStart: true,
        atEnd: true,
      },
    };

    setZhipinScrollViewDepsForTests({
      openNativePagePort: async () =>
        ({
          async scrollSurface() {
            return scrollResult;
          },
          close() {},
        }) as unknown as ZhipinNativePagePort,
      createNativeVisualActivitySession: createNoopSession,
    });

    const result = await zhipinScrollView.execute(
      { surface: "chat-list", steps: 0, settleMs: 0 },
      createTestContext(),
    );

    assert.equal(result.atTop, true);
    assert.equal(result.atBottom, true);
    assert.equal(result.canScrollUp, false);
    assert.equal(result.canScrollDown, false);
    assert.equal(result.position, "only-page");
  });
});
