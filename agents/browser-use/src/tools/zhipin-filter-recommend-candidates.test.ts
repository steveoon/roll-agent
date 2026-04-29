import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
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

  it("applies the normalized filter request through the native page port", async () => {
    const calls: string[] = [];
    const nativePage = {
      async bringToFront() {
        calls.push("front");
      },
      async waitForRecommendList(timeoutMs?: number) {
        calls.push(`wait-list:${timeoutMs}`);
        return true;
      },
      async applyRecommendFilter(
        requested: {
          readonly ageMin?: number;
          readonly ageMax?: number;
          readonly gender: string;
          readonly activity: string;
        },
        options?: {
          readonly preClickDelayMs?: number;
          readonly pressDurationMs?: number;
          readonly settleMs?: number;
        },
      ) {
        calls.push(`apply:${requested.gender}:${requested.activity}`);
        calls.push(
          `timing:${options?.preClickDelayMs}:${options?.pressDurationMs}:${options?.settleMs}`,
        );
        assert.deepEqual(requested, {
          ageMin: 20,
          ageMax: 40,
          gender: "男",
          activity: "刚刚活跃",
        });
        return {
          status: "applied" as const,
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
      close() {
        calls.push("close");
      },
    } as unknown as ZhipinNativePagePort;

    setZhipinFilterRecommendCandidatesDepsForTests({
      openNativePagePort: async () => nativePage,
      createNativeVisualActivitySession: () => ({
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
      "front",
      "begin:正在打开推荐筛选",
      "wait-list:3000",
      "begin:正在设置推荐筛选",
      "highlight:.recommend-filter .filter-label, .filter-label-wrap .filter-label, .filter-label",
      "apply:男:刚刚活跃",
      "timing:350:130:600",
      "succeed:已应用推荐筛选",
      "close",
    ]);
  });

  it("returns structured failure when the native helper reports a VIP gate", async () => {
    const nativePage = {
      async bringToFront() {},
      async waitForRecommendList() {
        return true;
      },
      async applyRecommendFilter(requested: {
        readonly gender: string;
        readonly activity: string;
      }) {
        return {
          status: "requires_vip" as const,
          requested,
          error: "筛选条件触发 VIP 弹窗",
        };
      },
      close() {},
    } as unknown as ZhipinNativePagePort;

    setZhipinFilterRecommendCandidatesDepsForTests({
      openNativePagePort: async () => nativePage,
      createNativeVisualActivitySession: () => ({
        async begin() {
          return true;
        },
        async highlightSelector() {
          return true;
        },
        async previewMouseMotion() {},
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
