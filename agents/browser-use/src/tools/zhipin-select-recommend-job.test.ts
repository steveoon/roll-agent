import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type {
  NativeRecommendJobSelectRequest,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import {
  setZhipinSelectRecommendJobDepsForTests,
  zhipinSelectRecommendJob,
} from "./zhipin-select-recommend-job.ts";

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
  setZhipinSelectRecommendJobDepsForTests(undefined);
});

describe("zhipin_select_recommend_job", () => {
  it("requires one job selector", () => {
    assert.throws(() => zhipinSelectRecommendJob.input.parse({}), /至少需要提供一个/);
  });

  it("selects a recommend job through the native page port", async () => {
    const calls: string[] = [];
    const nativePage = {
      async bringToFront() {
        calls.push("front");
      },
      async selectRecommendJob(
        request: NativeRecommendJobSelectRequest,
        options?: {
          readonly preClickDelayMs?: number;
          readonly pressDurationMs?: number;
          readonly settleMs?: number;
        },
      ) {
        calls.push(`select:${request.jobValue}:${request.jobName}:${request.useSearch}`);
        calls.push(
          `timing:${options?.preClickDelayMs}:${options?.pressDurationMs}:${options?.settleMs}`,
        );
        return {
          success: true,
          status: "selected" as const,
          requested: request,
          current: {
            index: 1,
            value: "job-2",
            label: "后厨 _ 上海 6-7K",
            isCurrent: true,
          },
          selected: {
            index: 1,
            value: "job-2",
            label: "后厨 _ 上海 6-7K",
            isCurrent: true,
          },
          options: [],
          matchedCount: 1,
        };
      },
      close() {
        calls.push("close");
      },
    } as unknown as ZhipinNativePagePort;

    setZhipinSelectRecommendJobDepsForTests({
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

    const result = await zhipinSelectRecommendJob.execute(
      { jobValue: "job-2", jobName: "后厨", useSearch: true },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.selected?.value, "job-2");
    assert.deepEqual(calls, [
      "front",
      "begin:正在选择推荐岗位",
      "highlight:.job-selecter-wrap",
      "select:job-2:后厨:true",
      "timing:900:180:1400",
      "succeed:已选择推荐岗位",
      "close",
    ]);
  });
});
