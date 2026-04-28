import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
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

function createNoopSession(calls: string[]) {
  return {
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
  };
}

function createNativePage(
  calls: string[],
  options: {
    readonly listReady?: boolean;
  } = {},
): ZhipinNativePagePort {
  return {
    async waitForRecommendList() {
      return options.listReady ?? true;
    },
    async readRecommendCandidates() {
      return {
        success: true,
        direction: "down",
        stepsRequested: 0,
        stepsCompleted: 0,
        reachedBoundary: false,
        before: {
          containerFound: true,
          containerLabel: "recommend-list",
          scrollTop: 0,
          scrollHeight: 1000,
          clientHeight: 600,
          itemCount: 1,
          atStart: true,
          atEnd: false,
        },
        after: {
          containerFound: true,
          containerLabel: "recommend-list",
          scrollTop: 0,
          scrollHeight: 1000,
          clientHeight: 600,
          itemCount: 1,
          atStart: true,
          atEnd: false,
        },
        items: [
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
        ],
        uniqueCount: 1,
        duplicateCount: 0,
        noNewRounds: 0,
        stopReason: "max-steps",
      };
    },
    close() {
      calls.push("close");
    },
  } as unknown as ZhipinNativePagePort;
}

afterEach(() => {
  setZhipinGetCandidateListDepsForTests(undefined);
});

describe("zhipin_get_candidate_list", () => {
  it("defaults to auto-scrolling with a bounded number of scrolls", () => {
    const parsed = zhipinGetCandidateList.input.parse({});

    assert.equal(parsed.autoScroll, true);
    assert.equal(parsed.maxScrolls, 4);
  });

  it("uses native backend and visual activity feedback while reading the recommend list", async () => {
    const calls: string[] = [];

    setZhipinGetCandidateListDepsForTests({
      openNativePagePort: async () => createNativePage(calls),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinGetCandidateList.execute(
      { maxResults: 1, autoScroll: false },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.total, 1);
    assert.deepEqual(calls, [
      "begin:正在打开推荐列表",
      "begin:正在读取推荐列表",
      "highlight:.candidate-card-wrap, li.card-item, [data-geek], .geek-item",
      "succeed:已读取 1 位候选人",
      "close",
    ]);
  });

  it("returns a structured failure when the native recommend list is not ready", async () => {
    const calls: string[] = [];

    setZhipinGetCandidateListDepsForTests({
      openNativePagePort: async () => createNativePage(calls, { listReady: false }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinGetCandidateList.execute(
      { maxResults: 1, autoScroll: false },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.equal(result.total, 0);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.error, "推荐列表未加载");
    assert.deepEqual(calls, ["begin:正在打开推荐列表", "fail:推荐列表未加载", "close"]);
  });
});
