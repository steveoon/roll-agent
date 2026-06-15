import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import {
  resetPreparedReplyStoreForTests,
  savePreparedReply,
} from "../reply-authority/prepared-reply-store.ts";
import {
  setZhipinJudgePreparedReplyDepsForTests,
  zhipinJudgePreparedReply,
} from "./zhipin-judge-prepared-reply.ts";

function createTestContext(llmText: string, onPrompt?: (prompt: string) => void): AgentContext {
  return {
    llm: {
      generateText: async (prompt) => {
        onPrompt?.(prompt);
        return llmText;
      },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

function saveDualPreparedReply() {
  return savePreparedReply(
    {
      signedEnvelope: "payload.draft.signature",
      suggestedReply: "你好，薪资可以详聊。",
      stage: "job_consultation",
      confidence: 0.9,
      expiresAt: 4_102_444_800,
      variantGroup: {
        groupId: "rvg_abc123",
        options: [
          {
            option: "option_1",
            variant: "draft",
            suggestedReply: "你好，薪资可以详聊。",
            signedEnvelope: "payload.draft.signature",
            envelopeExp: 4_102_444_800,
          },
          {
            option: "option_2",
            variant: "revised",
            suggestedReply: "你好，我可以帮你确认薪资范围。",
            signedEnvelope: "payload.revised.signature",
            envelopeExp: 4_102_444_800,
          },
        ],
        findings: [
          {
            code: "off_axis_fact_disclosure",
            description: "首稿包含候选人未询问的信息。",
          },
        ],
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
        target: {
          platform: "zhipin",
          tenantId: "tenant-001",
          conversationId: "conv-1",
        },
        recommendedOption: "option_1",
      },
    },
    1_800_000_000,
  );
}

afterEach(() => {
  resetPreparedReplyStoreForTests();
  setZhipinJudgePreparedReplyDepsForTests(undefined);
});

describe("zhipin_judge_prepared_reply", () => {
  it("returns a validated variantDecision from MCP sampling", async () => {
    const saved = saveDualPreparedReply();
    let prompt = "";
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
        rubric: {
          priorities: ["stay_on_axis"],
        },
        advisoryFindings: [
          {
            code: "off_axis_fact_disclosure",
            description: "首稿包含候选人未询问的信息。",
          },
        ],
      }),
    });

    const result = await zhipinJudgePreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        judgeModel: "test-judge",
      },
      createTestContext(
        JSON.stringify({
          chosenOption: "option_2",
          reason: "option_2 更聚焦候选人的薪资问题",
          confirmedFindingCodes: ["off_axis_fact_disclosure"],
        }),
        (capturedPrompt) => {
          prompt = capturedPrompt;
        },
      ),
    );

    assert.equal(result.success, true);
    assert.equal(result.variantDecision?.chosenOption, "option_2");
    assert.equal(result.variantDecision?.judgeModel, "test-judge");
    assert.deepEqual(result.variantDecision?.confirmedFindingCodes, ["off_axis_fact_disclosure"]);
    assert.match(prompt, /option_1/);
    assert.match(prompt, /option_2/);
    assert.match(prompt, /advisoryFindings/);
    assert.match(prompt, /首稿包含候选人未询问的信息。/);
    assert.match(prompt, /confirmedFindingCodes 与 chosenOption 相互独立/);
    assert.match(prompt, /哪怕你最终选择了包含该问题的 option/);
    assert.equal(prompt.includes("payload."), false);
  });

  it("falls back to the recommended option on rubric mismatch without calling the LLM", async () => {
    const saved = saveDualPreparedReply();
    let llmCalls = 0;
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:other",
        rubric: {},
        advisoryFindings: [],
      }),
    });

    const result = await zhipinJudgePreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext("{}", () => {
        llmCalls += 1;
      }),
    );

    assert.equal(result.success, true);
    assert.equal(result.fallback, true);
    assert.equal(result.recommendedOption, "option_1");
    assert.equal(result.variantDecision, undefined);
    assert.equal(llmCalls, 0);
  });
});
