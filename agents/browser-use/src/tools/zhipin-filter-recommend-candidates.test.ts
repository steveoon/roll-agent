import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import {
  setZhipinFilterRecommendCandidatesDepsForTests,
  zhipinFilterRecommendCandidates,
} from "./zhipin-filter-recommend-candidates.ts";

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
  setZhipinFilterRecommendCandidatesDepsForTests(undefined);
});

describe("zhipin_filter_recommend_candidates", () => {
  it("defaults gender and activity to unlimited", () => {
    const parsed = zhipinFilterRecommendCandidates.input.parse({});

    assert.equal(parsed.gender, "不限");
    assert.equal(parsed.activity, "不限");
  });

  it("rejects an inverted age range", () => {
    assert.throws(
      () => zhipinFilterRecommendCandidates.input.parse({ ageMin: 40, ageMax: 20 }),
      /ageMax must be greater than or equal to ageMin/,
    );
  });

  it("applies the normalized filter request through the page helper", async () => {
    const calls: string[] = [];
    const target = {};
    const page = {
      async bringToFront() {},
    };

    setZhipinFilterRecommendCandidatesDepsForTests({
      getContextManager: () =>
        ({
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            return page;
          },
        }) as never,
      getRecommendTarget: () => target as never,
      waitForRecommendFilterSurface: async () => true,
      applyRecommendFilter: async (_page, _target, requested, visualFeedback) => {
        assert.equal(_page, page);
        assert.equal(_target, target);
        assert.ok(visualFeedback);
        assert.deepEqual(requested, {
          ageMin: 20,
          ageMax: 40,
          gender: "男",
          activity: "刚刚活跃",
        });
        await visualFeedback.moveToLocator(page as never, {} as never, {
          target: target as never,
        });
        await visualFeedback.showClickOnLocator(page as never, {} as never, {
          target: target as never,
        });
        return {
          status: "applied",
          requested,
          applied: {
            ageMin: 20,
            ageMax: 40,
            gender: "男",
            activity: "刚刚活跃",
          },
          filterButtonText: "筛选·3",
        };
      },
      moveVisualCursorToLocator: async (_page, _locator, options) => {
        calls.push(`cursor-move:${String(options?.target === target)}`);
        return true;
      },
      showVisualClickOnLocator: async (_page, _locator, options) => {
        calls.push(`cursor-click:${String(options?.target === target)}`);
        return true;
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
    });

    const result = await zhipinFilterRecommendCandidates.execute(
      {
        ageMin: 20,
        ageMax: 40,
        gender: "男",
        activity: "刚刚活跃",
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.status, "applied");
    assert.equal(result.filterButtonText, "筛选·3");
    assert.deepEqual(calls, [
      "begin:正在打开推荐筛选",
      "retarget",
      "begin:正在设置推荐筛选",
      "highlight:.recommend-filter .filter-label, .filter-label-wrap .filter-label, .filter-label",
      "cursor-move:true",
      "cursor-click:true",
      "succeed:已应用推荐筛选",
    ]);
  });

  it("returns structured failure when the helper reports a VIP gate", async () => {
    const target = {};
    const page = {
      async bringToFront() {},
    };

    setZhipinFilterRecommendCandidatesDepsForTests({
      getContextManager: () =>
        ({
          async getPage() {
            return page;
          },
        }) as never,
      getRecommendTarget: () => target as never,
      waitForRecommendFilterSurface: async () => true,
      applyRecommendFilter: async (_page, _target, requested) => ({
        status: "requires_vip",
        requested,
        error: "筛选条件触发 VIP 弹窗",
      }),
      createVisualActivitySession: () => ({
        async begin() {
          return true;
        },
        async highlightSelector() {
          return true;
        },
        async retarget() {
          return true;
        },
        async succeed() {
          return true;
        },
        async fail() {
          return true;
        },
      }),
    });

    const result = await zhipinFilterRecommendCandidates.execute(
      {
        ageMin: 20,
        ageMax: 40,
        gender: "男",
        activity: "刚刚活跃",
      },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.equal(result.status, "requires_vip");
    assert.equal(result.error, "筛选条件触发 VIP 弹窗");
  });
});
