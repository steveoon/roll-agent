import { createHash } from "node:crypto";
import { defineTool } from "@roll-agent/sdk";
import { BrowserActionApprovalSchema } from "@roll-agent/browser";
import { postReplyFeedback, ReplyGateAdvisoryCodeSchema } from "@roll-agent/reply-authority-client";
import { z } from "zod";
import {
  consumePreparedReply,
  inspectPreparedReply,
  PreparedReplyOptionValues,
  type PreparedReplyRecord,
  type PreparedReplyVariantOption,
} from "../reply-authority/prepared-reply-store.ts";
import { sendSignedZhipinReply, type ZhipinSendReplyResult } from "./zhipin-send-reply.ts";
import { assertBrowserUseToolAllowed } from "../browser-use-policy.ts";
import { ToolActionApprovalSchema } from "../tool-action-approval.ts";
import { assertBrowserActionAllowed } from "../browser-security.ts";
import { getRuntime } from "../runtime-holder.ts";

const TOOL_NAME = "zhipin_send_prepared_reply";
const SUMMARY_MAX_LENGTH = 80;

const VariantDecisionSchema = z.object({
  chosenOption: z
    .enum(PreparedReplyOptionValues)
    .describe("从 replyVariantSelection.options 中选择的中性选项"),
  reason: z.string().min(1).max(500).describe("judge 选择该选项的简短理由"),
  confirmedFindingCodes: z
    .array(ReplyGateAdvisoryCodeSchema)
    .optional()
    .describe("确认属实的 replyVariantSelection.findings code；空数组表示 findings 是误报"),
  judgeModel: z.string().min(1).optional().describe("执行 judge 的模型 ID，写入服务端审计"),
});

type VariantDecision = z.infer<typeof VariantDecisionSchema>;

const OutputSchema = z.object({
  success: z.boolean(),
  sentMessage: z.string(),
  feedbackStatus: z.enum(["accepted", "duplicate", "skipped", "failed"]).optional(),
  feedbackError: z.string().optional(),
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
  variantDecision: VariantDecisionSchema.optional().describe(
    "双稿 preparedReplyId 的选择结果；不传时保持旧单稿/推荐稿发送行为，但不会回传 feedback。",
  ),
});

type ZhipinSendPreparedReplyInput = z.infer<typeof InputSchema>;
type ZhipinSendPreparedReplyOutput = z.infer<typeof OutputSchema>;

type ZhipinSendPreparedReplyDeps = {
  readonly sendSignedZhipinReply: typeof sendSignedZhipinReply;
  readonly postReplyFeedback: typeof postReplyFeedback;
};

let zhipinSendPreparedReplyDepsOverride: Partial<ZhipinSendPreparedReplyDeps> | undefined;

function getZhipinSendPreparedReplyDeps(): ZhipinSendPreparedReplyDeps {
  return {
    sendSignedZhipinReply,
    postReplyFeedback,
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

type PreparedReplySelection =
  | {
      readonly ok: true;
      readonly signedEnvelope: string;
      readonly suggestedReply: string;
      readonly unreadCountBeforeReply?: number;
      readonly chosenOption?: PreparedReplyVariantOption["option"];
      readonly chosenVariant?: PreparedReplyVariantOption["variant"];
      readonly variantDecision?: VariantDecision;
      readonly record: PreparedReplyRecord;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

function findVariantOption(
  record: PreparedReplyRecord,
  chosenOption: PreparedReplyVariantOption["option"],
): PreparedReplyVariantOption | undefined {
  return record.variantGroup?.options.find((option) => option.option === chosenOption);
}

function hasUnknownConfirmedFindingCode(record: PreparedReplyRecord, decision: VariantDecision) {
  if (decision.confirmedFindingCodes === undefined) {
    return false;
  }

  const knownCodes = new Set(record.variantGroup?.findings.map((finding) => finding.code) ?? []);
  return decision.confirmedFindingCodes.some((code) => !knownCodes.has(code));
}

function resolvePreparedReplySelection(
  record: PreparedReplyRecord,
  decision: VariantDecision | undefined,
): PreparedReplySelection {
  if (record.variantGroup === undefined) {
    if (decision !== undefined) {
      return {
        ok: false,
        error: "当前 preparedReplyId 没有双稿选项，不能提交 variantDecision",
      };
    }
    return {
      ok: true,
      signedEnvelope: record.signedEnvelope,
      suggestedReply: record.suggestedReply,
      ...(record.unreadCountBeforeReply !== undefined
        ? { unreadCountBeforeReply: record.unreadCountBeforeReply }
        : {}),
      record,
    };
  }

  if (decision !== undefined && hasUnknownConfirmedFindingCode(record, decision)) {
    return {
      ok: false,
      error: "variantDecision.confirmedFindingCodes 必须来自 replyVariantSelection.findings",
    };
  }

  const chosenOption = decision?.chosenOption ?? record.variantGroup.recommendedOption;
  const option = findVariantOption(record, chosenOption);
  if (option === undefined) {
    return {
      ok: false,
      error: `未找到双稿选项 ${chosenOption}`,
    };
  }

  return {
    ok: true,
    signedEnvelope: option.signedEnvelope,
    suggestedReply: option.suggestedReply,
    ...(record.unreadCountBeforeReply !== undefined
      ? { unreadCountBeforeReply: record.unreadCountBeforeReply }
      : {}),
    chosenOption: option.option,
    chosenVariant: option.variant,
    ...(decision !== undefined ? { variantDecision: decision } : {}),
    record,
  };
}

function createPreparedReplyDigest(
  selection: Extract<PreparedReplySelection, { ok: true }>,
): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        selection.record.preparedReplyId,
        selection.signedEnvelope,
        selection.suggestedReply,
        selection.record.expiresAt,
        selection.unreadCountBeforeReply,
        selection.record.variantGroup?.groupId,
        selection.chosenOption,
        selection.variantDecision?.reason,
        selection.variantDecision?.confirmedFindingCodes,
        selection.variantDecision?.judgeModel,
      ]),
    )
    .digest("hex")}`;
}

function createPreparedReplySummary(
  selection: Extract<PreparedReplySelection, { ok: true }>,
): string {
  const normalized = selection.suggestedReply.replace(/\s+/g, " ").trim();
  const preview =
    normalized.length > SUMMARY_MAX_LENGTH
      ? `${normalized.slice(0, SUMMARY_MAX_LENGTH - 1)}…`
      : normalized;
  const optionSuffix = selection.chosenOption !== undefined ? ` ${selection.chosenOption}` : "";
  return preview.length > 0
    ? `发送预备回复${optionSuffix}: ${preview}`
    : `发送预备回复${optionSuffix}`;
}

async function postFeedbackAfterSend(
  deps: ZhipinSendPreparedReplyDeps,
  selection: Extract<PreparedReplySelection, { ok: true }>,
  ctx: Parameters<typeof sendSignedZhipinReply>[1],
): Promise<Pick<ZhipinSendPreparedReplyOutput, "feedbackStatus" | "feedbackError">> {
  if (
    selection.record.variantGroup === undefined ||
    selection.variantDecision === undefined ||
    selection.chosenVariant === undefined
  ) {
    return selection.record.variantGroup !== undefined ? { feedbackStatus: "skipped" } : {};
  }

  try {
    const response = await deps.postReplyFeedback({
      groupId: selection.record.variantGroup.groupId,
      target: selection.record.variantGroup.target,
      chosenVariant: selection.chosenVariant,
      ...(selection.variantDecision.confirmedFindingCodes !== undefined
        ? { confirmedFindingCodes: selection.variantDecision.confirmedFindingCodes }
        : {}),
      reason: selection.variantDecision.reason,
      rubricVersion: selection.record.variantGroup.rubricVersion,
      rubricHash: selection.record.variantGroup.rubricHash,
      ...(selection.variantDecision.judgeModel !== undefined
        ? { judgeModel: selection.variantDecision.judgeModel }
        : {}),
    });
    return { feedbackStatus: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(`Reply feedback failed after sending prepared reply: ${message}`);
    return {
      feedbackStatus: "failed",
      feedbackError: message,
    };
  }
}

export const zhipinSendPreparedReply = defineTool<
  ZhipinSendPreparedReplyInput,
  ZhipinSendPreparedReplyOutput
>({
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
    const inspectedSelection = resolvePreparedReplySelection(
      inspected.record,
      input.variantDecision,
    );
    if (!inspectedSelection.ok) {
      return {
        success: false,
        sentMessage: "",
        error: inspectedSelection.error,
      };
    }

    const preparedReplyDigest = createPreparedReplyDigest(inspectedSelection);
    const browserActionTarget = `${inspectedSelection.record.preparedReplyId}:${preparedReplyDigest}`;
    const toolGuard = assertBrowserUseToolAllowed(ctx, {
      subject: {
        tool: TOOL_NAME,
        target: inspectedSelection.record.preparedReplyId,
        summary: createPreparedReplySummary(inspectedSelection),
        digest: preparedReplyDigest,
      },
      ...(input.toolActionApproval !== undefined ? { approval: input.toolActionApproval } : {}),
      deferApprovalConsumption: true,
    });

    assertBrowserActionAllowed(ctx, getRuntime(), {
      action: TOOL_NAME,
      target: browserActionTarget,
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
    const consumedSelection = resolvePreparedReplySelection(consumed.record, input.variantDecision);
    if (!consumedSelection.ok) {
      return {
        success: false,
        sentMessage: "",
        error: consumedSelection.error,
      };
    }

    const sendResult: ZhipinSendReplyResult = await deps.sendSignedZhipinReply(
      {
        signedEnvelope: consumedSelection.signedEnvelope,
        ...(consumedSelection.unreadCountBeforeReply !== undefined
          ? { unreadCountBeforeReply: consumedSelection.unreadCountBeforeReply }
          : {}),
      },
      ctx,
    );
    if (!sendResult.success) {
      return sendResult;
    }

    const feedbackResult = await postFeedbackAfterSend(deps, consumedSelection, ctx);
    return {
      ...sendResult,
      ...feedbackResult,
    };
  },
});
