import { createHash } from "node:crypto";
import { defineTool } from "@roll-agent/sdk";
import { BrowserActionApprovalSchema } from "@roll-agent/browser";
import { z } from "zod";
import {
  consumePreparedReply,
  inspectPreparedReply,
  type PreparedReplyRecord,
} from "../reply-authority/prepared-reply-store.ts";
import { sendSignedZhipinReply } from "./zhipin-send-reply.ts";
import { assertBrowserUseToolAllowed } from "../browser-use-policy.ts";
import { ToolActionApprovalSchema } from "../tool-action-approval.ts";
import { assertBrowserActionAllowed } from "../browser-security.ts";
import { getRuntime } from "../runtime-holder.ts";

const TOOL_NAME = "zhipin_send_prepared_reply";
const SUMMARY_MAX_LENGTH = 80;

const OutputSchema = z.object({
  success: z.boolean(),
  sentMessage: z.string(),
  error: z.string().optional(),
});

const InputSchema = z.object({
  preparedReplyId: z.string().min(1).describe("预备回复 ID，由 zhipin_generate_reply_preview 返回"),
  toolActionApproval: ToolActionApprovalSchema.optional().describe(
    "当 browser-use tool policy 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID。",
  ),
  browserActionApproval: BrowserActionApprovalSchema.optional().describe(
    "当 BROWSER_SECURITY_JSON.actionPolicy=confirm 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID。",
  ),
});

type ZhipinSendPreparedReplyDeps = {
  readonly sendSignedZhipinReply: typeof sendSignedZhipinReply;
};

let zhipinSendPreparedReplyDepsOverride: Partial<ZhipinSendPreparedReplyDeps> | undefined;

function getZhipinSendPreparedReplyDeps(): ZhipinSendPreparedReplyDeps {
  return {
    sendSignedZhipinReply,
    ...zhipinSendPreparedReplyDepsOverride,
  };
}

export function setZhipinSendPreparedReplyDepsForTests(
  override: Partial<ZhipinSendPreparedReplyDeps> | undefined,
): void {
  zhipinSendPreparedReplyDepsOverride = override;
}

function formatPreparedReplyError(reason: "not_found" | "expired" | "consumed"): string {
  if (reason === "expired") {
    return "preparedReplyId 已过期，请重新生成回复";
  }
  if (reason === "consumed") {
    return "preparedReplyId 已消费，禁止重复发送";
  }
  return "preparedReplyId 不存在，请重新生成回复";
}

function createPreparedReplyDigest(record: PreparedReplyRecord): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        record.preparedReplyId,
        record.signedEnvelope,
        record.suggestedReply,
        record.expiresAt,
        record.unreadCountBeforeReply,
      ]),
    )
    .digest("hex")}`;
}

function createPreparedReplySummary(record: PreparedReplyRecord): string {
  const normalized = record.suggestedReply.replace(/\s+/g, " ").trim();
  const preview =
    normalized.length > SUMMARY_MAX_LENGTH
      ? `${normalized.slice(0, SUMMARY_MAX_LENGTH - 1)}…`
      : normalized;
  return preview.length > 0 ? `发送预备回复: ${preview}` : "发送预备回复";
}

export const zhipinSendPreparedReply = defineTool({
  name: TOOL_NAME,
  description:
    "发送由 zhipin_generate_reply_preview 生成的预备回复；只接收 preparedReplyId，不接收 signedEnvelope。",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const deps = getZhipinSendPreparedReplyDeps();
    const inspected = inspectPreparedReply(input.preparedReplyId);
    if (!inspected.ok) {
      return {
        success: false,
        sentMessage: "",
        error: formatPreparedReplyError(inspected.reason),
      };
    }

    const toolGuard = assertBrowserUseToolAllowed(ctx, {
      subject: {
        tool: TOOL_NAME,
        target: inspected.record.preparedReplyId,
        summary: createPreparedReplySummary(inspected.record),
        digest: createPreparedReplyDigest(inspected.record),
      },
      ...(input.toolActionApproval !== undefined ? { approval: input.toolActionApproval } : {}),
      deferApprovalConsumption: true,
    });

    assertBrowserActionAllowed(ctx, getRuntime(), {
      action: TOOL_NAME,
      target: inspected.record.preparedReplyId,
      ...(input.browserActionApproval !== undefined
        ? { approval: input.browserActionApproval }
        : {}),
    });

    toolGuard.consumeApproval();

    const consumed = consumePreparedReply(input.preparedReplyId);
    if (!consumed.ok) {
      return {
        success: false,
        sentMessage: "",
        error: formatPreparedReplyError(consumed.reason),
      };
    }

    return await deps.sendSignedZhipinReply(
      {
        signedEnvelope: consumed.record.signedEnvelope,
        ...(consumed.record.unreadCountBeforeReply !== undefined
          ? { unreadCountBeforeReply: consumed.record.unreadCountBeforeReply }
          : {}),
      },
      ctx,
    );
  },
});
