import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { clearZhipinRecommendJobRefsForTests } from "../pages/zhipin/semantic-refs.ts";
import {
  setZhipinListRecommendJobsDepsForTests,
  zhipinListRecommendJobs,
} from "./zhipin-list-recommend-jobs.ts";

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
  setZhipinListRecommendJobsDepsForTests(undefined);
  clearZhipinRecommendJobRefsForTests();
});

describe("zhipin_list_recommend_jobs", () => {
  it("lists recommend jobs and assigns semantic refs", async () => {
    const calls: string[] = [];
    const nativePage = {
      async bringToFront() {
        calls.push("front");
      },
      async listRecommendJobs(options?: {
        readonly preClickDelayMs?: number;
        readonly pressDurationMs?: number;
        readonly settleMs?: number;
      }) {
        calls.push(
          `timing:${options?.preClickDelayMs}:${options?.pressDurationMs}:${options?.settleMs}`,
        );
        return {
          success: true,
          status: "listed" as const,
          current: {
            index: 0,
            value: "job-a",
            label: "服务员 _ 上海 5-6K",
            isCurrent: true,
          },
          options: [
            {
              index: 0,
              value: "job-a",
              label: "服务员 _ 上海 5-6K",
              isCurrent: true,
            },
            {
              index: 1,
              value: "job-b",
              label: "后厨 _ 上海 6-7K",
              isCurrent: false,
            },
          ],
          availableCount: 2,
          canSwitch: true,
        };
      },
      close() {
        calls.push("close");
      },
    } as unknown as ZhipinNativePagePort;

    setZhipinListRecommendJobsDepsForTests({
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

    const result = await zhipinListRecommendJobs.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.canSwitch, true);
    assert.equal(result.current?.jobRef, "@j1");
    assert.deepEqual(
      result.jobs.map((job) => [job.jobRef, job.value]),
      [
        ["@j1", "job-a"],
        ["@j2", "job-b"],
      ],
    );
    assert.deepEqual(calls, [
      "begin:正在读取推荐岗位",
      "highlight:.job-selecter-wrap",
      "timing:450:140:750",
      "succeed:已读取 2 个推荐岗位",
      "close",
    ]);
  });

  it("returns a structured failure when the selector is unavailable", async () => {
    const nativePage = {
      async bringToFront() {},
      async listRecommendJobs() {
        return {
          success: false,
          status: "selector_not_found" as const,
          options: [],
          availableCount: 0,
          canSwitch: false,
          error: "未找到岗位下拉",
        };
      },
      close() {},
    } as unknown as ZhipinNativePagePort;

    setZhipinListRecommendJobsDepsForTests({
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

    const result = await zhipinListRecommendJobs.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.status, "selector_not_found");
    assert.equal(result.jobs.length, 0);
    assert.equal(result.error, "未找到岗位下拉");
  });
});
