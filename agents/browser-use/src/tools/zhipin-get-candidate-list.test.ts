import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import {
  setZhipinGetCandidateListDepsForTests,
  zhipinGetCandidateList,
} from "./zhipin-get-candidate-list.ts";

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
  setZhipinGetCandidateListDepsForTests(undefined);
});

describe("zhipin_get_candidate_list", () => {
  it("uses visual activity feedback while reading the recommend list", async () => {
    const calls: string[] = [];
    const page = {};
    const target = {
      async evaluate() {
        return [
          {
            index: 0,
            candidateId: "candidate-1",
            name: "赵慧珍",
            age: "24岁",
            experience: "3年",
            education: "本科",
            workStatus: "在职",
            company: "花卷科技",
            currentPosition: "前端工程师",
            expectedLocation: "上海",
            expectedPosition: "前端工程师",
            expectedSalary: "20-30K",
            tags: ["React"],
            buttonText: "打招呼",
          },
        ];
      },
    };

    setZhipinGetCandidateListDepsForTests({
      getContextManager: () =>
        ({
          async getPage(platform: string) {
            assert.equal(platform, "zhipin");
            return page;
          },
        }) as never,
      getRecommendTarget: () => target as never,
      waitForRecommendList: async () => true,
      createVisualActivitySession: () => ({
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
        async retarget() {
          calls.push("retarget");
          return true;
        },
      }),
    });

    const result = await zhipinGetCandidateList.execute({ maxResults: 1 }, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.total, 1);
    assert.deepEqual(calls, [
      "begin:正在打开推荐列表",
      "retarget",
      "begin:正在读取推荐列表",
      "highlight:.candidate-card-wrap, [data-geek], .geek-item",
      "succeed:已读取 1 位候选人",
    ]);
  });
});
