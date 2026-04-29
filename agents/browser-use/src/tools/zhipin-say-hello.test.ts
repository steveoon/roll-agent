import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
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
  it("clicks greet buttons through the native page port and keeps visual feedback", async () => {
    const calls: string[] = [];
    const nativePage = {
      async waitForRecommendList() {
        calls.push("wait-list");
        return true;
      },
      async clickRecommendGreet(
        index: number,
        options?: {
          readonly preClickDelayMs?: number;
          readonly pressDurationMs?: number;
          readonly settleMs?: number;
        },
      ) {
        calls.push(`greet:${index}`);
        calls.push(
          `timing:${options?.preClickDelayMs}:${options?.pressDurationMs}:${options?.settleMs}`,
        );
        return {
          found: true,
          cardSelector: ".candidate-card-wrap",
          candidateId: "candidate-1",
          name: "赵慧珍",
          hasGreetButton: true,
          clicked: true,
        };
      },
      close() {
        calls.push("close");
      },
    } as unknown as ZhipinNativePagePort;

    setZhipinSayHelloDepsForTests({
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
      sleep: async (ms: number) => {
        calls.push(`sleep:${ms}`);
      },
    });

    const result = await zhipinSayHello.execute({ indices: [0, 1] }, createTestContext());

    assert.equal(result.success, true);
    assert.deepEqual(result.results, [
      {
        index: 0,
        candidateName: "赵慧珍",
        candidateId: "candidate-1",
        success: true,
      },
      {
        index: 1,
        candidateName: "赵慧珍",
        candidateId: "candidate-1",
        success: true,
      },
    ]);
    assert.deepEqual(calls, [
      "begin:正在打开推荐列表",
      "wait-list",
      "begin:正在批量打招呼",
      "highlight:.candidate-card-wrap, [data-geek], .geek-item",
      "greet:0",
      "timing:650:140:1200",
      "sleep:2400",
      "greet:1",
      "timing:650:140:1200",
      "succeed:已完成 2/2 位候选人",
      "close",
    ]);
  });

  it("fails closed when the native recommend list is unavailable", async () => {
    const nativePage = {
      async waitForRecommendList() {
        return false;
      },
      close() {},
    } as unknown as ZhipinNativePagePort;

    setZhipinSayHelloDepsForTests({
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

    const result = await zhipinSayHello.execute({ indices: [2] }, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.results[0]?.error, "推荐列表未加载");
  });
});
