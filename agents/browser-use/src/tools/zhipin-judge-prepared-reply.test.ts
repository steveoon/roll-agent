import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import {
  resetPreparedReplyStoreForTests,
  savePreparedReply,
} from "../reply-authority/prepared-reply-store.ts";
import { PreparedReplyFallbackReasons } from "../reply-authority/prepared-reply-decision.ts";
import {
  setZhipinJudgePreparedReplyDepsForTests,
  zhipinJudgePreparedReply,
} from "./zhipin-judge-prepared-reply.ts";

function createTestContext(
  llmResult: string | Error,
  onPrompt?: (prompt: string) => void,
  onWarn?: (message: string) => void,
): AgentContext {
  return {
    llm: {
      generateText: async (prompt) => {
        onPrompt?.(prompt);
        if (llmResult instanceof Error) {
          throw llmResult;
        }
        return llmResult;
      },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message) => {
        onWarn?.(message);
      },
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
        state: "judge_ready",
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
        judgeContext: {
          candidateMessage: "请问这个岗位每天几点上班？",
          recentConversation: ["求职者: 请问这个岗位每天几点上班？"],
          candidateInfo: {
            communicationPosition: "服务员",
            expectedLocation: "成都",
          },
        },
      },
    },
    1_800_000_000,
  );
}

function saveNotLearnedPreparedReply() {
  return savePreparedReply(
    {
      signedEnvelope: "payload.draft.signature",
      suggestedReply: "你好，薪资可以详聊。",
      stage: "job_consultation",
      confidence: 0.9,
      expiresAt: 4_102_444_800,
      variantGroup: {
        state: "not_learned",
        groupId: "rvg_fallback",
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
        target: {
          platform: "zhipin",
          tenantId: "tenant-001",
          conversationId: "conv-1",
        },
        chosenVariant: "draft",
        reason: PreparedReplyFallbackReasons.INVALID_VARIANT_SHAPE,
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
    assert.equal(result.decisionSource, "judge");
    assert.equal(result.variantDecision?.chosenOption, "option_2");
    assert.equal(result.variantDecision?.judgeModel, "test-judge");
    assert.deepEqual(result.variantDecision?.confirmedFindingCodes, ["off_axis_fact_disclosure"]);
    assert.match(prompt, /option_1/);
    assert.match(prompt, /option_2/);
    assert.match(prompt, /advisoryFindings/);
    assert.match(prompt, /首稿包含候选人未询问的信息。/);
    assert.match(prompt, /confirmedFindingCodes 与 chosenOption 相互独立/);
    assert.match(prompt, /哪怕最终选择了包含该问题的 option/);
    assert.match(prompt, /请问这个岗位每天几点上班/);
    assert.match(prompt, /目标贴合、合规、事实安全/);
    assert.match(prompt, /不得自行补充、改写或推断岗位事实/);
    assert.match(prompt, /禁止只写“更好”“更自然”/);
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
    assert.equal(result.error, PreparedReplyFallbackReasons.RUBRIC_MISMATCH);
    assert.equal(llmCalls, 0);
  });

  it("keeps raw sampling errors local and returns a stable safe fallback reason", async () => {
    const saved = saveDualPreparedReply();
    const warnings: string[] = [];
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
        rubric: {},
        advisoryFindings: [],
      }),
    });

    const result = await zhipinJudgePreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext(
        new Error("provider echoed candidate phone 13800138000"),
        undefined,
        (message) => warnings.push(message),
      ),
    );

    assert.equal(result.success, true);
    assert.equal(result.fallback, true);
    assert.equal(result.error, PreparedReplyFallbackReasons.JUDGE_SAMPLING_FAILED);
    assert.equal(JSON.stringify(result).includes("13800138000"), false);
    assert.equal(
      warnings.some((message) => message.includes("13800138000")),
      true,
    );
  });

  it("does not turn an omitted confirmedFindingCodes field into false negative evidence", async () => {
    const saved = saveDualPreparedReply();
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
        rubric: {},
        advisoryFindings: [],
      }),
    });

    const result = await zhipinJudgePreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext(
        JSON.stringify({
          chosenOption: "option_2",
          reason: "option_2 更直接回应排班问题",
        }),
      ),
    );

    assert.equal(result.success, true);
    assert.equal(result.fallback, true);
    assert.equal(result.decisionSource, "service_recommended_fallback");
    assert.equal(result.variantDecision, undefined);
    assert.equal(result.error, PreparedReplyFallbackReasons.JUDGE_OUTPUT_INVALID);
  });

  it("returns a precomputed non-learning terminal state without fetching rubric or sampling", async () => {
    const saved = saveNotLearnedPreparedReply();
    let rubricCalls = 0;
    let llmCalls = 0;
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => {
        rubricCalls += 1;
        throw new Error("must not be called");
      },
    });

    const result = await zhipinJudgePreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext("{}", () => {
        llmCalls += 1;
      }),
    );

    assert.equal(result.success, true);
    assert.equal(result.fallback, true);
    assert.equal(result.recommendedOption, undefined);
    assert.equal(result.error, PreparedReplyFallbackReasons.INVALID_VARIANT_SHAPE);
    assert.equal(rubricCalls, 0);
    assert.equal(llmCalls, 0);
  });

  it("caches the default judge result so approval retries do not choose again", async () => {
    const saved = saveDualPreparedReply();
    let llmCalls = 0;
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
        rubric: {},
        advisoryFindings: [],
      }),
    });
    const context = createTestContext(
      JSON.stringify({
        chosenOption: "option_1",
        reason: "option_1 已直接回答候选人的排班问题",
        confirmedFindingCodes: [],
      }),
      () => {
        llmCalls += 1;
      },
    );

    const first = await zhipinJudgePreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      context,
    );
    const second = await zhipinJudgePreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      context,
    );

    assert.deepEqual(second.variantDecision, first.variantDecision);
    assert.equal(llmCalls, 1);
  });
});
