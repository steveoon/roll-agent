import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { StructuredToolError, type AgentContext } from "@roll-agent/sdk";
import { BrowserRuntimeConfigSchema, type BrowserRuntime } from "@roll-agent/browser";
import { resetBrowserUsePolicyForTests, setBrowserUsePolicy } from "../browser-use-policy.ts";
import { resetBrowserActionApprovalsForTests } from "../browser-action-approval.ts";
import { resetToolActionApprovalsForTests } from "../tool-action-approval.ts";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import {
  consumePreparedReply,
  inspectPreparedReply,
  resetPreparedReplyStoreForTests,
  savePreparedReply,
} from "../reply-authority/prepared-reply-store.ts";
import {
  setZhipinSendPreparedReplyDepsForTests,
  zhipinSendPreparedReply,
} from "./zhipin-send-prepared-reply.ts";

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
  setRuntimeStateForTests({ runtime: createRuntime() });
});

afterEach(() => {
  resetPreparedReplyStoreForTests();
  resetBrowserUsePolicyForTests();
  resetBrowserActionApprovalsForTests();
  resetToolActionApprovalsForTests();
  setZhipinSendPreparedReplyDepsForTests(undefined);
  setRuntimeStateForTests({});
});

describe("zhipin_send_prepared_reply", () => {
  function saveTestPreparedReply(suggestedReply = "你好") {
    return savePreparedReply(
      {
        signedEnvelope: `payload.${suggestedReply}.signature`,
        suggestedReply,
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 4_102_444_800,
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
