import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import { StructuredToolError } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  ZHIPIN_ACCESS_RESTRICTED_CODE,
  createZhipinAccessRestrictedError,
} from "../pages/zhipin/risk-page.ts";
import {
  clearZhipinCandidateRefsForTests,
  rememberZhipinCandidateRefs,
} from "../pages/zhipin/semantic-refs.ts";
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
  clearZhipinCandidateRefsForTests();
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

    const result = await zhipinSayHello.execute(
      { candidateRefs: ["@c1", "@c2"] },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(result.results, [
      {
        index: 0,
        candidateRef: "@c1",
        candidateName: "赵慧珍",
        candidateId: "candidate-1",
        success: true,
      },
      {
        index: 1,
        candidateRef: "@c2",
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
      "timing:450:140:750",
      "sleep:1400",
      "greet:1",
      "timing:450:140:750",
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

    const result = await zhipinSayHello.execute({ candidateRefs: ["@c3"] }, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.results[0]?.candidateRef, "@c3");
    assert.equal(result.results[0]?.error, "推荐列表未加载");
  });

  it("does not click when a remembered candidate ref no longer matches the current DOM index", async () => {
    const calls: string[] = [];
    rememberZhipinCandidateRefs([
      { index: 0, candidateId: "candidate-expected", name: "候选人 A" },
    ]);
    const nativePage = {
      async waitForRecommendList() {
        return true;
      },
      async inspectRecommendCard(index: number) {
        calls.push(`inspect:${index}`);
        return {
          found: true,
          cardSelector: ".candidate-card-wrap",
          candidateId: "candidate-other",
          name: "候选人 B",
          hasGreetButton: true,
        };
      },
      async clickRecommendGreet(index: number) {
        calls.push(`greet:${index}`);
        return {
          found: true,
          cardSelector: ".candidate-card-wrap",
          candidateId: "candidate-other",
          name: "候选人 B",
          hasGreetButton: true,
          clicked: true,
        };
      },
      async assertNotRestricted() {
        calls.push("risk-check");
      },
      close() {
        calls.push("close");
      },
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

    const result = await zhipinSayHello.execute({ candidateRefs: ["@c1"] }, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.results[0]?.candidateRef, "@c1");
    assert.match(result.results[0]?.error ?? "", /已过期/);
    assert.deepEqual(calls, ["inspect:0", "risk-check", "close"]);
  });

  it("rejects invalid candidate refs before execution", () => {
    assert.throws(
      () => zhipinSayHello.input.parse({ candidateRefs: ["candidate-1"] }),
      /candidateRef 应类似 @c1/,
    );
  });

  it("aborts the batch when a remembered ref inspect fails because of a risk page", async () => {
    const calls: string[] = [];
    rememberZhipinCandidateRefs([
      { index: 0, candidateId: "candidate-1", name: "候选人 A" },
      { index: 1, candidateId: "candidate-2", name: "候选人 B" },
    ]);
    const nativePage = {
      async waitForRecommendList() {
        return true;
      },
      async inspectRecommendCard(index: number) {
        calls.push(`inspect:${index}`);
        return {
          found: false,
          cardSelector: "",
          candidateId: "",
          name: "",
          hasGreetButton: false,
        };
      },
      async clickRecommendGreet(index: number) {
        calls.push(`greet:${index}`);
        return {
          found: false,
          cardSelector: "",
          candidateId: "",
          name: "",
          hasGreetButton: false,
          clicked: false,
          error: "未找到候选人卡片",
        };
      },
      async assertNotRestricted() {
        calls.push("risk-check");
        throw createZhipinAccessRestrictedError({
          kind: "ip_block",
          url: "https://www.zhipin.com/web/passport/zp/403.html?code=31",
          title: "访问受限",
        });
      },
      close() {
        calls.push("close");
      },
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
          calls.push("visual-fail");
          return true;
        },
      }),
      sleep: async () => {},
    });

    await assert.rejects(
      zhipinSayHello.execute({ candidateRefs: ["@c1", "@c2"] }, createTestContext()),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, ZHIPIN_ACCESS_RESTRICTED_CODE);
        return true;
      },
    );
    assert.deepEqual(calls, ["inspect:0", "risk-check", "close"]);
  });

  it("aborts the batch when a failed click reveals a risk page", async () => {
    const calls: string[] = [];
    const nativePage = {
      async waitForRecommendList() {
        return true;
      },
      async clickRecommendGreet(index: number) {
        calls.push(`greet:${index}`);
        return {
          found: false,
          cardSelector: "",
          candidateId: "",
          name: "",
          hasGreetButton: false,
          clicked: false,
          error: "未找到候选人卡片",
        };
      },
      async assertNotRestricted() {
        calls.push("risk-check");
        throw createZhipinAccessRestrictedError({
          kind: "ip_block",
          url: "https://www.zhipin.com/web/passport/zp/403.html?code=31",
          title: "访问受限",
        });
      },
      close() {
        calls.push("close");
      },
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
          calls.push("visual-fail");
          return true;
        },
      }),
      sleep: async () => {},
    });

    await assert.rejects(
      zhipinSayHello.execute({ candidateRefs: ["@c1", "@c2"] }, createTestContext()),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, ZHIPIN_ACCESS_RESTRICTED_CODE);
        return true;
      },
    );
    assert.deepEqual(calls, ["greet:0", "risk-check", "close"]);
  });

  it("continues the batch when a failed click happens on a normal page", async () => {
    const calls: string[] = [];
    const nativePage = {
      async waitForRecommendList() {
        return true;
      },
      async clickRecommendGreet(index: number) {
        calls.push(`greet:${index}`);
        return {
          found: index !== 0,
          cardSelector: ".candidate-card-wrap",
          candidateId: `candidate-${index}`,
          name: `候选人 ${index}`,
          hasGreetButton: index !== 0,
          clicked: index !== 0,
          ...(index === 0 ? { error: "未找到候选人卡片" } : {}),
        };
      },
      async assertNotRestricted() {
        calls.push("risk-check");
      },
      close() {
        calls.push("close");
      },
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
      sleep: async () => {},
    });

    const result = await zhipinSayHello.execute(
      { candidateRefs: ["@c1", "@c2"] },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.succeeded, 1);
    assert.deepEqual(calls, ["greet:0", "risk-check", "greet:1", "close"]);
  });
});
