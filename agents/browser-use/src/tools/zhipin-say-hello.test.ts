import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import { setZhipinSayHelloDepsForTests, zhipinSayHello } from "./zhipin-say-hello.ts";

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

afterEach(() => {
  setZhipinSayHelloDepsForTests(undefined);
});

describe("zhipin_say_hello", () => {
  it("keeps visual cursor and adds visual activity feedback", async () => {
    const activityCalls: string[] = [];
    const cursorCalls: string[] = [];
    const cursorOptions: Array<Record<string, unknown> | undefined> = [];
    const page = {};
    const greetButton = {
      async scrollIntoViewIfNeeded() {},
      async hover() {},
      async click() {},
    };
    const card = {
      locator(selector: string) {
        assert.equal(selector, "button.btn.btn-greet");
        return {
          first() {
            return greetButton;
          },
        };
      },
    };
    const target = {
      locator(selector: string) {
        assert.equal(selector, ".candidate-card-wrap");
        return {
          nth(index: number) {
            assert.equal(index, 0);
            return card;
          },
        };
      },
    };

    setZhipinSayHelloDepsForTests({
      getContextManager: () =>
        ({
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            return page;
          },
        }) as never,
      getRecommendTarget: () => target as never,
      waitForRecommendList: async () => true,
      inspectRecommendCard: async () => ({
        found: true,
        cardSelector: ".candidate-card-wrap",
        candidateId: "candidate-1",
        name: "赵慧珍",
        hasGreetButton: true,
      }),
      moveVisualCursorToLocator: async (_page, _locator, options) => {
        cursorCalls.push("move");
        cursorOptions.push(options as Record<string, unknown> | undefined);
        return true;
      },
      showVisualClickOnLocator: async (_page, _locator, options) => {
        cursorCalls.push("click");
        cursorOptions.push(options as Record<string, unknown> | undefined);
        return true;
      },
      humanDelay: async () => {},
      shouldAddRandomBehavior: () => false,
      performRandomScroll: async () => {},
      createVisualActivitySession: () => ({
        async begin(label: string) {
          activityCalls.push(`begin:${label}`);
          return true;
        },
        async highlightSelector(selector: string) {
          activityCalls.push(`highlight-selector:${selector}`);
          return true;
        },
        async highlightLocator() {
          activityCalls.push("highlight-locator");
          return true;
        },
        async succeed(label: string) {
          activityCalls.push(`succeed:${label}`);
          return true;
        },
        async fail(label: string) {
          activityCalls.push(`fail:${label}`);
          return true;
        },
        async retarget() {
          activityCalls.push("retarget");
          return true;
        },
      }),
    });

    const result = await zhipinSayHello.execute({ indices: [0] }, createTestContext());

    assert.equal(result.success, true);
    assert.deepEqual(cursorCalls, ["move", "click"]);
    assert.deepEqual(cursorOptions, [
      { durationMs: 90, settleMs: 20, target },
      { pulseDurationMs: 160, target },
    ]);
    assert.deepEqual(activityCalls, [
      "begin:正在打开推荐列表",
      "retarget",
      "begin:正在打招呼",
      "highlight-selector:.candidate-card-wrap, [data-geek], .geek-item",
      "highlight-locator",
      "succeed:已完成 1/1 位候选人",
    ]);
  });
});
