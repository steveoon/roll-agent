import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { StructuredToolError, type AgentContext } from "@roll-agent/sdk";
import { BrowserRuntimeConfigSchema, type BrowserRuntime } from "@roll-agent/browser";
import { resetBrowserUsePolicyForTests, setBrowserUsePolicy } from "../browser-use-policy.ts";
import { resetBrowserActionApprovalsForTests } from "../browser-action-approval.ts";
import { resetToolActionApprovalsForTests } from "../tool-action-approval.ts";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import {
  PreparedReplyFallbackReasons,
  type PreparedReplyFallbackReason,
  type PreparedReplyVariantDecision,
} from "../reply-authority/prepared-reply-decision.ts";
import {
  consumePreparedReply,
  inspectPreparedReply,
  resetPreparedReplyStoreForTests,
  savePreparedReply,
} from "../reply-authority/prepared-reply-store.ts";
import {
  initializeReplyFeedbackOutbox,
  shutdownReplyFeedbackOutbox,
} from "../reply-authority/reply-feedback-outbox.ts";
import { setZhipinJudgePreparedReplyDepsForTests } from "./zhipin-judge-prepared-reply.ts";
import {
  setZhipinSendPreparedReplyDepsForTests,
  zhipinSendPreparedReply,
} from "./zhipin-send-prepared-reply.ts";

function createTestContext(llmText = ""): AgentContext {
  return {
    llm: {
      generateText: async () => llmText,
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

let outboxDirectory = "";

function createRuntime(actionPolicy: "log" | "deny" | "confirm" = "log"): BrowserRuntime {
  return {
    getConfig() {
      return BrowserRuntimeConfigSchema.parse({
        security: {
          actionPolicy,
        },
      });
    },
  } as BrowserRuntime;
}

beforeEach(() => {
  outboxDirectory = mkdtempSync(join(tmpdir(), "roll-feedback-outbox-"));
  initializeReplyFeedbackOutbox({
    dbPath: join(outboxDirectory, "outbox.sqlite"),
    flushIntervalMs: 60_000,
  });
  setRuntimeStateForTests({ runtime: createRuntime() });
});

afterEach(async () => {
  await shutdownReplyFeedbackOutbox();
  rmSync(outboxDirectory, { recursive: true, force: true });
  resetPreparedReplyStoreForTests();
  resetBrowserUsePolicyForTests();
  resetBrowserActionApprovalsForTests();
  resetToolActionApprovalsForTests();
  setZhipinSendPreparedReplyDepsForTests(undefined);
  setZhipinJudgePreparedReplyDepsForTests(undefined);
  setRuntimeStateForTests({});
});

describe("zhipin_send_prepared_reply", () => {
  function saveTestPreparedReply(suggestedReply = "你好", unreadCountBeforeReply?: number) {
    return savePreparedReply(
      {
        signedEnvelope: `payload.${suggestedReply}.signature`,
        suggestedReply,
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 4_102_444_800,
        ...(unreadCountBeforeReply !== undefined ? { unreadCountBeforeReply } : {}),
      },
      1_800_000_000,
    );
  }

  function saveDualPreparedReply(groupId = "rvg_abc123") {
    return savePreparedReply(
      {
        signedEnvelope: "payload.draft.signature",
        suggestedReply: "你好，薪资可以详聊。",
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 4_102_444_800,
        unreadCountBeforeReply: 2,
        variantGroup: {
          state: "judge_ready",
          groupId,
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
          feedbackExpiresAt: 4_102_444_900,
          target: {
            platform: "zhipin",
            tenantId: "tenant-001",
            conversationId: "conv-1",
          },
          recommendedOption: "option_1",
          judgeContext: {
            candidateMessage: "薪资多少？",
            recentConversation: [],
          },
        },
      },
      1_800_000_000,
    );
  }

  function saveNotLearnedPreparedReply(
    reason: PreparedReplyFallbackReason = PreparedReplyFallbackReasons.INVALID_VARIANT_SHAPE,
  ) {
    return savePreparedReply(
      {
        signedEnvelope: "payload.draft.signature",
        suggestedReply: "你好，薪资可以详聊。",
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 4_102_444_800,
        unreadCountBeforeReply: 2,
        variantGroup: {
          state: "not_learned",
          groupId: "rvg_preview_fallback",
          rubricVersion: "reply-quality-v1",
          rubricHash: "sha256:test",
          feedbackExpiresAt: 4_102_444_900,
          target: {
            platform: "zhipin",
            tenantId: "tenant-001",
            conversationId: "conv-1",
          },
          chosenVariant: "draft",
          reason,
        },
      },
      1_800_000_000,
    );
  }

  function readApprovalIdFromError(error: unknown): string {
    assert.ok(error instanceof StructuredToolError);
    const approvalRequest = error.payload.details?.["approvalRequest"];
    assert.equal(typeof approvalRequest, "object");
    assert.notEqual(approvalRequest, null);
    assert.equal(typeof (approvalRequest as Record<string, unknown>)["id"], "string");
    return (approvalRequest as { id: string }).id;
  }

  it("returns structured failure when the prepared reply is missing", async () => {
    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: "prep_missing" },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.equal(result.sentMessage, "");
    assert.match(result.error ?? "", /preparedReplyId 不存在/);
    assert.equal("signedEnvelope" in result, false);
  });

  it("does not expose the envelope for expired prepared replies", async () => {
    const saved = savePreparedReply(
      {
        signedEnvelope: "payload.signature",
        suggestedReply: "你好",
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 1,
      },
      0,
    );

    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.equal(result.sentMessage, "");
    assert.equal("signedEnvelope" in result, false);
  });

  it("keeps the compatible default behavior when no tool policy is configured", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveTestPreparedReply("你好");
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "你好" };
      },
    });

    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(sentEnvelopes, [saved.signedEnvelope]);
    assert.deepEqual(consumePreparedReply(saved.preparedReplyId), {
      ok: false,
      reason: "consumed",
    });
  });

  it("passes prepared unread context to signed reply sending", async () => {
    const sentUnreadCounts: Array<number | undefined> = [];
    const saved = saveTestPreparedReply("你好", 2);
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentUnreadCounts.push(input.unreadCountBeforeReply);
        return { success: true, sentMessage: "你好" };
      },
    });

    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(sentUnreadCounts, [2]);
  });

  it("sends the selected dual-draft envelope and posts feedback", async () => {
    const sent: Array<{ readonly envelope: string; readonly unread?: number }> = [];
    const feedbackBodies: unknown[] = [];
    const feedbackDeadlines: Array<number | undefined> = [];
    const saved = saveDualPreparedReply();
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sent.push({
          envelope: input.signedEnvelope,
          ...(input.unreadCountBeforeReply !== undefined
            ? { unread: input.unreadCountBeforeReply }
            : {}),
        });
        return { success: true, sentMessage: "你好，我可以帮你确认薪资范围。" };
      },
      submitReplyFeedback: async (body, _deliver, _logger, options) => {
        feedbackBodies.push(body);
        feedbackDeadlines.push(options?.feedbackExpiresAt);
        return { status: "accepted" };
      },
    });

    const result = await zhipinSendPreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        variantDecision: {
          chosenOption: "option_2",
          reason: "option_2 更直接回应薪资问题",
          confirmedFindingCodes: ["off_axis_fact_disclosure"],
          judgeModel: "test-judge",
        },
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.feedbackStatus, "accepted");
    assert.deepEqual(sent, [{ envelope: "payload.revised.signature", unread: 2 }]);
    assert.equal(
      (feedbackBodies[0] as { readonly chosenVariant?: string } | undefined)?.chosenVariant,
      "revised",
    );
    assert.deepEqual(
      (feedbackBodies[0] as { readonly confirmedFindingCodes?: readonly string[] } | undefined)
        ?.confirmedFindingCodes,
      ["off_axis_fact_disclosure"],
    );
    assert.deepEqual(feedbackBodies[0], {
      groupId: "rvg_abc123",
      target: {
        platform: "zhipin",
        tenantId: "tenant-001",
        conversationId: "conv-1",
      },
      chosenVariant: "revised",
      feedbackOutcome: "selected",
      decisionSource: "orchestrator",
      confirmedFindingCodes: ["off_axis_fact_disclosure"],
      reason: "option_2 更直接回应薪资问题",
      rubricVersion: "reply-quality-v1",
      rubricHash: "sha256:test",
      judgeModel: "test-judge",
    });
    assert.deepEqual(feedbackDeadlines, [4_102_444_900]);
  });

  it("automatically judges dual drafts and posts feedback when variantDecision is omitted", async () => {
    const sentEnvelopes: string[] = [];
    const feedbackBodies: unknown[] = [];
    const saved = saveDualPreparedReply();
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
        rubric: {},
        advisoryFindings: [],
      }),
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "你好，薪资可以详聊。" };
      },
      postReplyFeedback: async (body) => {
        feedbackBodies.push(body);
        return { status: "accepted", groupId: body.groupId };
      },
    });

    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext(
        JSON.stringify({
          chosenOption: "option_2",
          reason: "option_2 更直接回应候选人的薪资问题，且没有额外承诺",
          confirmedFindingCodes: ["off_axis_fact_disclosure"],
        }),
      ),
    );

    assert.equal(result.success, true);
    assert.equal(result.feedbackStatus, "accepted");
    assert.equal(result.decisionSource, "judge");
    assert.equal(result.chosenOption, "option_2");
    assert.equal(result.feedbackExpected, true);
    assert.match(result.decisionReason ?? "", /更直接回应候选人的薪资问题/);
    assert.deepEqual(sentEnvelopes, ["payload.revised.signature"]);
    assert.equal(feedbackBodies.length, 1);
  });

  it("sends the recommended option without learning when the default judge falls back", async () => {
    const sentEnvelopes: string[] = [];
    const feedbackBodies: unknown[] = [];
    const saved = saveDualPreparedReply();
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:mismatch",
        rubric: {},
        advisoryFindings: [],
      }),
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "你好，薪资可以详聊。" };
      },
      postReplyFeedback: async (body) => {
        feedbackBodies.push(body);
        return { status: "accepted", groupId: body.groupId };
      },
    });

    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.decisionSource, "service_recommended_fallback");
    assert.equal(result.feedbackExpected, false);
    assert.equal(result.feedbackStatus, "accepted");
    assert.deepEqual(sentEnvelopes, ["payload.draft.signature"]);
    assert.deepEqual(feedbackBodies, [
      {
        groupId: "rvg_abc123",
        target: {
          platform: "zhipin",
          tenantId: "tenant-001",
          conversationId: "conv-1",
        },
        chosenVariant: "draft",
        feedbackOutcome: "not_learned",
        decisionSource: "service_recommended_fallback",
        reason: PreparedReplyFallbackReasons.RUBRIC_MISMATCH,
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
      },
    ]);
  });

  it("sends a preview-degraded draft and closes its non-learning feedback outcome", async () => {
    const sentEnvelopes: string[] = [];
    const feedbackBodies: unknown[] = [];
    const feedbackDeadlines: Array<number | undefined> = [];
    const saved = saveNotLearnedPreparedReply(PreparedReplyFallbackReasons.RUBRIC_FETCH_FAILED);
    let rubricCalls = 0;
    let llmCalls = 0;
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => {
        rubricCalls += 1;
        throw new Error("must not be called");
      },
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "你好，薪资可以详聊。" };
      },
      submitReplyFeedback: async (body, _deliver, _logger, options) => {
        feedbackBodies.push(body);
        feedbackDeadlines.push(options?.feedbackExpiresAt);
        return { status: "accepted" };
      },
    });
    const context: AgentContext = {
      ...createTestContext(),
      llm: {
        generateText: async () => {
          llmCalls += 1;
          throw new Error("must not be called");
        },
      },
    };

    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      context,
    );

    assert.equal(result.success, true);
    assert.equal(result.chosenOption, undefined);
    assert.equal(result.decisionSource, "service_recommended_fallback");
    assert.equal(result.decisionReason, PreparedReplyFallbackReasons.RUBRIC_FETCH_FAILED);
    assert.equal(result.feedbackExpected, false);
    assert.equal(result.feedbackStatus, "accepted");
    assert.equal(rubricCalls, 0);
    assert.equal(llmCalls, 0);
    assert.deepEqual(sentEnvelopes, ["payload.draft.signature"]);
    assert.deepEqual(feedbackBodies, [
      {
        groupId: "rvg_preview_fallback",
        target: {
          platform: "zhipin",
          tenantId: "tenant-001",
          conversationId: "conv-1",
        },
        chosenVariant: "draft",
        feedbackOutcome: "not_learned",
        decisionSource: "service_recommended_fallback",
        reason: PreparedReplyFallbackReasons.RUBRIC_FETCH_FAILED,
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
      },
    ]);
    assert.deepEqual(feedbackDeadlines, [4_102_444_900]);
  });

  it("rejects a forged learning decision for a preview-degraded reply", async () => {
    const sentEnvelopes: string[] = [];
    const feedbackBodies: unknown[] = [];
    const saved = saveNotLearnedPreparedReply();
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
      postReplyFeedback: async (body) => {
        feedbackBodies.push(body);
        return { status: "accepted", groupId: body.groupId };
      },
    });

    const result = await zhipinSendPreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        variantDecision: {
          chosenOption: "option_2",
          reason: "伪造一个学习选择",
          confirmedFindingCodes: [],
        },
      },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /已降级为非学习终态，禁止提交学习 decision/);
    assert.deepEqual(sentEnvelopes, []);
    assert.deepEqual(feedbackBodies, []);
    assert.equal(inspectPreparedReply(saved.preparedReplyId).ok, true);
  });

  it("rejects a forged variantDecision after the cached default judge falls back", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveDualPreparedReply();
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:mismatch",
        rubric: {},
        advisoryFindings: [],
      }),
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
    });

    await assert.rejects(
      zhipinSendPreparedReply.execute(
        { preparedReplyId: saved.preparedReplyId },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        return true;
      },
    );

    const result = await zhipinSendPreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        variantDecision: {
          chosenOption: "option_2",
          reason: "伪造一个可学习选择",
          confirmedFindingCodes: ["off_axis_fact_disclosure"],
        },
      },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /默认 Judge 已降级，禁止事后伪造学习 decision/);
    assert.deepEqual(sentEnvelopes, []);
    assert.equal(inspectPreparedReply(saved.preparedReplyId).ok, true);
  });

  it("records an explicit no-judge break-glass send without learning feedback", async () => {
    const sentEnvelopes: string[] = [];
    const feedbackBodies: unknown[] = [];
    const saved = saveDualPreparedReply();
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "你好，薪资可以详聊。" };
      },
      postReplyFeedback: async (body) => {
        feedbackBodies.push(body);
        return { status: "accepted", groupId: body.groupId };
      },
    });

    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId, skipVariantJudge: true },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.decisionSource, "explicit_no_judge");
    assert.equal(result.feedbackExpected, false);
    assert.equal(result.feedbackStatus, "accepted");
    assert.deepEqual(sentEnvelopes, ["payload.draft.signature"]);
    assert.deepEqual(feedbackBodies, [
      {
        groupId: "rvg_abc123",
        target: {
          platform: "zhipin",
          tenantId: "tenant-001",
          conversationId: "conv-1",
        },
        chosenVariant: "draft",
        feedbackOutcome: "not_learned",
        decisionSource: "explicit_no_judge",
        reason: "调用方显式跳过双稿 Judge",
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
      },
    ]);
  });

  it("consumes a dual-draft group after sending one option", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveDualPreparedReply();
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
      postReplyFeedback: async (body) => ({ status: "accepted", groupId: body.groupId }),
    });

    const first = await zhipinSendPreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        variantDecision: {
          chosenOption: "option_1",
          reason: "首稿已经足够准确",
        },
      },
      createTestContext(),
    );
    const second = await zhipinSendPreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        variantDecision: {
          chosenOption: "option_2",
          reason: "尝试发送另一稿",
        },
      },
      createTestContext(),
    );

    assert.equal(first.success, true);
    assert.equal(second.success, false);
    assert.match(second.error ?? "", /已消费/);
    assert.deepEqual(sentEnvelopes, ["payload.draft.signature"]);
  });

  it("queues transient feedback failures but marks permanent failures without resending", async () => {
    for (const scenario of [
      { statusCode: 404, expectedStatus: "failed" },
      { statusCode: 409, expectedStatus: "failed" },
      { statusCode: 500, expectedStatus: "queued" },
    ] as const) {
      resetPreparedReplyStoreForTests();
      const sentEnvelopes: string[] = [];
      const saved = saveDualPreparedReply(`rvg_${String(scenario.statusCode)}`);
      setZhipinSendPreparedReplyDepsForTests({
        sendSignedZhipinReply: async (input) => {
          sentEnvelopes.push(input.signedEnvelope);
          return { success: true, sentMessage: "sent" };
        },
        postReplyFeedback: async () => {
          throw Object.assign(new Error(`reply feedback ${String(scenario.statusCode)}`), {
            statusCode: scenario.statusCode,
          });
        },
      });

      const result = await zhipinSendPreparedReply.execute(
        {
          preparedReplyId: saved.preparedReplyId,
          variantDecision: {
            chosenOption: "option_2",
            reason: "改写稿更聚焦",
          },
        },
        createTestContext(),
      );

      assert.equal(result.success, true);
      assert.equal(result.feedbackStatus, scenario.expectedStatus);
      assert.match(
        result.feedbackError ?? "",
        new RegExp(`reply feedback ${String(scenario.statusCode)}`),
      );
      assert.deepEqual(sentEnvelopes, ["payload.revised.signature"]);
    }
  });

  it("reports a durable outbox failure without rolling back or repeating the sent message", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveDualPreparedReply();
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
      submitReplyFeedback: async () => {
        throw new Error("sqlite disk full");
      },
    });

    const result = await zhipinSendPreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        variantDecision: {
          chosenOption: "option_2",
          reason: "option_2 更聚焦",
          confirmedFindingCodes: [],
        },
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.feedbackStatus, "failed");
    assert.match(result.feedbackError ?? "", /sqlite disk full/);
    assert.deepEqual(sentEnvelopes, ["payload.revised.signature"]);
  });

  it("returns needs_confirmation without consuming the prepared reply when policy is confirm", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveTestPreparedReply("你好");
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "你好" };
      },
    });

    await assert.rejects(
      zhipinSendPreparedReply.execute(
        { preparedReplyId: saved.preparedReplyId },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        assert.equal(error.payload.details?.["tool"], "zhipin_send_prepared_reply");
        assert.equal(error.payload.details?.["target"], saved.preparedReplyId);
        return true;
      },
    );

    assert.deepEqual(sentEnvelopes, []);
    assert.equal(consumePreparedReply(saved.preparedReplyId).ok, true);
  });

  it("sends a confirm-gated prepared reply when retried with matching approval", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveTestPreparedReply("你好，可以的");
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "你好，可以的" };
      },
    });

    let approvalId = "";
    await assert.rejects(
      zhipinSendPreparedReply.execute(
        { preparedReplyId: saved.preparedReplyId },
        createTestContext(),
      ),
      (error) => {
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );

    const result = await zhipinSendPreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        toolActionApproval: { id: approvalId },
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(sentEnvelopes, [saved.signedEnvelope]);
    assert.deepEqual(consumePreparedReply(saved.preparedReplyId), {
      ok: false,
      reason: "consumed",
    });
  });

  it("reuses the cached Judge and model when a matching replay omits judgeModel", async () => {
    const sentEnvelopes: string[] = [];
    const feedbackBodies: unknown[] = [];
    const saved = saveDualPreparedReply();
    let llmCalls = 0;
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
        rubric: {},
        advisoryFindings: [],
      }),
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
      postReplyFeedback: async (body) => {
        feedbackBodies.push(body);
        return { status: "accepted", groupId: body.groupId };
      },
    });
    const context: AgentContext = {
      ...createTestContext(),
      llm: {
        generateText: async () => {
          llmCalls += 1;
          return JSON.stringify({
            chosenOption: "option_2",
            reason: "option_2 更直接回应候选人的薪资问题",
            confirmedFindingCodes: ["off_axis_fact_disclosure"],
          });
        },
      },
    };

    let approvalId = "";
    await assert.rejects(
      zhipinSendPreparedReply.execute({ preparedReplyId: saved.preparedReplyId }, context),
      (error) => {
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );
    const result = await zhipinSendPreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        toolActionApproval: { id: approvalId },
        variantDecision: {
          chosenOption: "option_2",
          reason: "option_2 更直接回应候选人的薪资问题",
          confirmedFindingCodes: ["off_axis_fact_disclosure"],
        },
      },
      context,
    );

    assert.equal(result.success, true);
    assert.equal(result.decisionSource, "judge");
    assert.equal(result.chosenOption, "option_2");
    assert.equal(result.judgeModel, "mcp-sampling");
    assert.equal(llmCalls, 1);
    assert.deepEqual(sentEnvelopes, ["payload.revised.signature"]);
    assert.equal(
      (feedbackBodies[0] as { readonly judgeModel?: string } | undefined)?.judgeModel,
      "mcp-sampling",
    );
  });

  it("rejects a variantDecision that differs from the cached default judge decision", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveDualPreparedReply();
    let llmCalls = 0;
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    setZhipinJudgePreparedReplyDepsForTests({
      fetchReplyFeedbackRubric: async () => ({
        rubricVersion: "reply-quality-v1",
        rubricHash: "sha256:test",
        rubric: {},
        advisoryFindings: [],
      }),
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
    });
    const context: AgentContext = {
      ...createTestContext(),
      llm: {
        generateText: async () => {
          llmCalls += 1;
          return JSON.stringify({
            chosenOption: "option_2",
            reason: "option_2 更直接回应候选人的薪资问题",
            confirmedFindingCodes: ["off_axis_fact_disclosure"],
          });
        },
      },
    };

    await assert.rejects(
      zhipinSendPreparedReply.execute({ preparedReplyId: saved.preparedReplyId }, context),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        return true;
      },
    );

    const mismatchedDecisions: PreparedReplyVariantDecision[] = [
      {
        chosenOption: "option_1",
        reason: "option_2 更直接回应候选人的薪资问题",
        confirmedFindingCodes: ["off_axis_fact_disclosure"],
      },
      {
        chosenOption: "option_2",
        reason: "改写后的理由不应覆盖缓存 Judge",
        confirmedFindingCodes: ["off_axis_fact_disclosure"],
      },
      {
        chosenOption: "option_2",
        reason: "option_2 更直接回应候选人的薪资问题",
        confirmedFindingCodes: [],
      },
    ];
    for (const variantDecision of mismatchedDecisions) {
      const result = await zhipinSendPreparedReply.execute(
        {
          preparedReplyId: saved.preparedReplyId,
          variantDecision,
        },
        context,
      );

      assert.equal(result.success, false);
      assert.match(result.error ?? "", /variantDecision 与已缓存的 Judge 结果不一致/);
    }
    assert.equal(llmCalls, 1);
    assert.deepEqual(sentEnvelopes, []);
    assert.equal(inspectPreparedReply(saved.preparedReplyId).ok, true);
  });

  it("does not allow a dual-draft tool approval for a different chosen option", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveDualPreparedReply();
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
      postReplyFeedback: async (body) => ({ status: "accepted", groupId: body.groupId }),
    });

    let approvalId = "";
    await assert.rejects(
      zhipinSendPreparedReply.execute(
        {
          preparedReplyId: saved.preparedReplyId,
          variantDecision: {
            chosenOption: "option_1",
            reason: "首稿够好",
          },
        },
        createTestContext(),
      ),
      (error) => {
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );

    await assert.rejects(
      zhipinSendPreparedReply.execute(
        {
          preparedReplyId: saved.preparedReplyId,
          variantDecision: {
            chosenOption: "option_2",
            reason: "改写稿更好",
          },
          toolActionApproval: { id: approvalId },
        },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        return true;
      },
    );

    assert.deepEqual(sentEnvelopes, []);
    assert.equal(consumePreparedReply(saved.preparedReplyId).ok, true);
  });

  it("does not allow a tool approval for a different prepared reply", async () => {
    const sentEnvelopes: string[] = [];
    const first = saveTestPreparedReply("第一条");
    const second = saveTestPreparedReply("第二条");
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
    });

    let approvalId = "";
    await assert.rejects(
      zhipinSendPreparedReply.execute(
        { preparedReplyId: first.preparedReplyId },
        createTestContext(),
      ),
      (error) => {
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );

    await assert.rejects(
      zhipinSendPreparedReply.execute(
        {
          preparedReplyId: second.preparedReplyId,
          toolActionApproval: { id: approvalId },
        },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        return true;
      },
    );

    assert.deepEqual(sentEnvelopes, []);
    assert.equal(consumePreparedReply(second.preparedReplyId).ok, true);
  });

  it("does not allow a dual-draft browser action approval for a different chosen option", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveDualPreparedReply();
    setRuntimeStateForTests({ runtime: createRuntime("confirm") });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
      postReplyFeedback: async (body) => ({ status: "accepted", groupId: body.groupId }),
    });

    let approvalId = "";
    await assert.rejects(
      zhipinSendPreparedReply.execute(
        {
          preparedReplyId: saved.preparedReplyId,
          variantDecision: {
            chosenOption: "option_1",
            reason: "首稿够好",
          },
        },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        assert.equal(error.payload.details?.["reason"], "action_policy_confirm");
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );

    await assert.rejects(
      zhipinSendPreparedReply.execute(
        {
          preparedReplyId: saved.preparedReplyId,
          variantDecision: {
            chosenOption: "option_2",
            reason: "改写稿更好",
          },
          browserActionApproval: { id: approvalId },
        },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        assert.equal(error.payload.details?.["reason"], "action_policy_confirm");
        return true;
      },
    );

    assert.deepEqual(sentEnvelopes, []);
    assert.equal(consumePreparedReply(saved.preparedReplyId).ok, true);
  });

  it("denies a prepared reply without consuming it when policy is deny", async () => {
    const saved = saveTestPreparedReply("你好");
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "deny" },
      },
    });

    await assert.rejects(
      zhipinSendPreparedReply.execute(
        { preparedReplyId: saved.preparedReplyId },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "action_denied");
        return true;
      },
    );

    assert.equal(consumePreparedReply(saved.preparedReplyId).ok, true);
  });

  it("denies a prepared reply without consuming it when browser action policy is deny", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveTestPreparedReply("你好");
    setRuntimeStateForTests({ runtime: createRuntime("deny") });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "sent" };
      },
    });

    await assert.rejects(
      zhipinSendPreparedReply.execute(
        { preparedReplyId: saved.preparedReplyId },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "action_denied");
        assert.equal(error.payload.details?.["action"], "zhipin_send_prepared_reply");
        return true;
      },
    );

    assert.deepEqual(sentEnvelopes, []);
    assert.equal(inspectPreparedReply(saved.preparedReplyId).ok, true);
  });

  it("keeps tool approval valid across a later browser-action confirmation", async () => {
    const sentEnvelopes: string[] = [];
    const saved = saveTestPreparedReply("你好，可以的");
    setRuntimeStateForTests({ runtime: createRuntime("confirm") });
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    setZhipinSendPreparedReplyDepsForTests({
      sendSignedZhipinReply: async (input) => {
        sentEnvelopes.push(input.signedEnvelope);
        return { success: true, sentMessage: "你好，可以的" };
      },
    });

    let toolApprovalId = "";
    await assert.rejects(
      zhipinSendPreparedReply.execute(
        { preparedReplyId: saved.preparedReplyId },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        assert.equal(error.payload.details?.["reason"], "tool_policy_confirm");
        toolApprovalId = readApprovalIdFromError(error);
        return true;
      },
    );

    let browserApprovalId = "";
    await assert.rejects(
      zhipinSendPreparedReply.execute(
        {
          preparedReplyId: saved.preparedReplyId,
          toolActionApproval: { id: toolApprovalId },
        },
        createTestContext(),
      ),
      (error) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        assert.equal(error.payload.details?.["reason"], "action_policy_confirm");
        browserApprovalId = readApprovalIdFromError(error);
        return true;
      },
    );

    assert.equal(inspectPreparedReply(saved.preparedReplyId).ok, true);

    const result = await zhipinSendPreparedReply.execute(
      {
        preparedReplyId: saved.preparedReplyId,
        toolActionApproval: { id: toolApprovalId },
        browserActionApproval: { id: browserApprovalId },
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(sentEnvelopes, [saved.signedEnvelope]);
    assert.deepEqual(consumePreparedReply(saved.preparedReplyId), {
      ok: false,
      reason: "consumed",
    });
  });
});
