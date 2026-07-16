import { createHash } from "node:crypto";
import { BrowserActionApprovalSchema } from "@roll-agent/browser";
import { postReplyFeedback, type ReplyFeedbackBody } from "@roll-agent/reply-authority-client";
import { defineTool, type AgentContext } from "@roll-agent/sdk";
import { z } from "zod";
import { assertBrowserActionAllowed } from "../browser-security.ts";
import { assertBrowserUseToolAllowed } from "../browser-use-policy.ts";
import {
  PreparedReplyOptionValues,
  PreparedReplySendDecisionSourceValues,
  PreparedReplyVariantDecisionSchema,
  type PreparedReplyFallbackReason,
  type PreparedReplyJudgement,
  type PreparedReplySendDecisionSource,
  type PreparedReplyVariantDecision,
} from "../reply-authority/prepared-reply-decision.ts";
import { submitReplyFeedback } from "../reply-authority/reply-feedback-outbox.ts";
import {
  consumePreparedReply,
  inspectPreparedReply,
  type PreparedReplyRecord,
  type PreparedReplyVariantOption,
} from "../reply-authority/prepared-reply-store.ts";
import { getRuntime } from "../runtime-holder.ts";
import { ToolActionApprovalSchema } from "../tool-action-approval.ts";
import { ensurePreparedReplyJudgement } from "./zhipin-judge-prepared-reply.ts";
import { sendSignedZhipinReply, type ZhipinSendReplyResult } from "./zhipin-send-reply.ts";

const TOOL_NAME = "zhipin_send_prepared_reply";
const SUMMARY_MAX_LENGTH = 80;

const OutputSchema = z.object({
  success: z.boolean(),
  sentMessage: z.string(),
  chosenOption: z.enum(PreparedReplyOptionValues).optional(),
  decisionSource: z.enum(PreparedReplySendDecisionSourceValues).optional(),
  decisionReason: z.string().optional(),
  judgeModel: z.string().optional(),
  feedbackExpected: z.boolean().optional(),
  feedbackStatus: z.enum(["accepted", "duplicate", "queued", "skipped", "failed"]).optional(),
  feedbackError: z.string().optional(),
  error: z.string().optional(),
});

const InputSchema = z
  .object({
    preparedReplyId: z
      .string()
      .min(1)
      .describe("预备回复 ID，由 zhipin_generate_reply_preview 返回"),
    toolActionApproval: ToolActionApprovalSchema.optional().describe(
      "当 browser-use tool policy 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID。",
    ),
    browserActionApproval: BrowserActionApprovalSchema.optional().describe(
      "当 BROWSER_SECURITY_JSON.actionPolicy=confirm 返回 needs_confirmation 后，由 orchestrator 原样带回的批准 ID。",
    ),
    variantDecision: PreparedReplyVariantDecisionSchema.optional().describe(
      "可选的显式双稿选择；缺省时发送工具会自动执行并缓存默认 Judge。",
    ),
    skipVariantJudge: z
      .boolean()
      .optional()
      .describe(
        "仅用于明确的应急降级：跳过双稿 Judge、发送服务端推荐稿并回传 not_learned 终态，但不产生学习样本。",
      ),
  })
  .superRefine((input, ctx) => {
    if (input.variantDecision !== undefined && input.skipVariantJudge === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "variantDecision 与 skipVariantJudge 不能同时传入",
        path: ["skipVariantJudge"],
      });
    }
  });

type ZhipinSendPreparedReplyInput = z.infer<typeof InputSchema>;
type ZhipinSendPreparedReplyOutput = z.infer<typeof OutputSchema>;

type ZhipinSendPreparedReplyDeps = {
  readonly sendSignedZhipinReply: typeof sendSignedZhipinReply;
  readonly postReplyFeedback: typeof postReplyFeedback;
  readonly submitReplyFeedback: typeof submitReplyFeedback;
};

let zhipinSendPreparedReplyDepsOverride: Partial<ZhipinSendPreparedReplyDeps> | undefined;

function getZhipinSendPreparedReplyDeps(): ZhipinSendPreparedReplyDeps {
  return {
    sendSignedZhipinReply,
    postReplyFeedback,
    submitReplyFeedback,
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

type PreparedReplyDecisionResolution =
  | { readonly kind: "single" }
  | {
      readonly kind: "decision";
      readonly source: "judge" | "orchestrator";
      readonly decision: PreparedReplyVariantDecision;
    }
  | {
      readonly kind: "fallback";
      readonly source: "service_recommended_fallback";
      readonly recommendedOption: PreparedReplyVariantOption["option"];
      readonly reason: PreparedReplyFallbackReason;
    }
  | {
      readonly kind: "terminal_fallback";
      readonly source: "service_recommended_fallback";
      readonly chosenVariant: "draft";
      readonly reason: PreparedReplyFallbackReason;
    }
  | {
      readonly kind: "explicit_no_judge";
      readonly source: "explicit_no_judge";
      readonly recommendedOption: PreparedReplyVariantOption["option"];
      readonly reason: string;
    };

type PreparedReplySelection =
  | {
      readonly ok: true;
      readonly signedEnvelope: string;
      readonly suggestedReply: string;
      readonly unreadCountBeforeReply?: number;
      readonly chosenOption?: PreparedReplyVariantOption["option"];
      readonly chosenVariant?: PreparedReplyVariantOption["variant"];
      readonly variantDecision?: PreparedReplyVariantDecision;
      readonly decisionSource?: PreparedReplySendDecisionSource;
      readonly decisionReason?: string;
      readonly record: PreparedReplyRecord;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

function sameVariantDecision(
  left: PreparedReplyVariantDecision,
  right: PreparedReplyVariantDecision,
): boolean {
  // judgeModel is cached Judge provenance, not caller-controlled decision content.
  const normalizeCodes = (codes: readonly string[] | undefined) =>
    codes === undefined ? undefined : [...codes].sort();
  return (
    left.chosenOption === right.chosenOption &&
    left.reason === right.reason &&
    JSON.stringify(normalizeCodes(left.confirmedFindingCodes)) ===
      JSON.stringify(normalizeCodes(right.confirmedFindingCodes))
  );
}

function judgementToResolution(judgement: PreparedReplyJudgement): PreparedReplyDecisionResolution {
  if (judgement.kind === "decision") {
    return {
      kind: "decision",
      source: judgement.source,
      decision: judgement.decision,
    };
  }
  return {
    kind: "fallback",
    source: judgement.source,
    recommendedOption: judgement.recommendedOption,
    reason: judgement.reason,
  };
}

async function resolvePreparedReplyDecision(
  record: PreparedReplyRecord,
  input: Pick<ZhipinSendPreparedReplyInput, "variantDecision" | "skipVariantJudge">,
  ctx: AgentContext,
): Promise<PreparedReplyDecisionResolution | { readonly kind: "error"; readonly error: string }> {
  const variantGroup = record.variantGroup;
  if (variantGroup === undefined) {
    if (input.variantDecision !== undefined || input.skipVariantJudge === true) {
      return {
        kind: "error",
        error: "当前 preparedReplyId 没有双稿选项，不能提交双稿选择或跳过 Judge",
      };
    }
    return { kind: "single" };
  }
  if (variantGroup.state === "not_learned") {
    if (input.variantDecision !== undefined) {
      return {
        kind: "error",
        error: "当前 preparedReplyId 已降级为非学习终态，禁止提交学习 decision",
      };
    }
    return {
      kind: "terminal_fallback",
      source: "service_recommended_fallback",
      chosenVariant: variantGroup.chosenVariant,
      reason: variantGroup.reason,
    };
  }

  if (input.variantDecision !== undefined) {
    if (record.judgement !== undefined) {
      if (record.judgement.kind === "fallback") {
        return {
          kind: "error",
          error: "当前 preparedReplyId 的默认 Judge 已降级，禁止事后伪造学习 decision",
        };
      }
      if (!sameVariantDecision(record.judgement.decision, input.variantDecision)) {
        return {
          kind: "error",
          error: "variantDecision 与已缓存的 Judge 结果不一致，请重新生成回复",
        };
      }
      return judgementToResolution(record.judgement);
    }
    return {
      kind: "decision",
      source: "orchestrator",
      decision: input.variantDecision,
    };
  }

  if (input.skipVariantJudge === true) {
    if (record.judgement !== undefined) {
      return judgementToResolution(record.judgement);
    }
    return {
      kind: "explicit_no_judge",
      source: "explicit_no_judge",
      recommendedOption: variantGroup.recommendedOption,
      reason: "调用方显式跳过双稿 Judge",
    };
  }

  return judgementToResolution(await ensurePreparedReplyJudgement(record, ctx));
}

function findVariantOption(
  record: PreparedReplyRecord,
  chosenOption: PreparedReplyVariantOption["option"],
): PreparedReplyVariantOption | undefined {
  return record.variantGroup?.state === "judge_ready"
    ? record.variantGroup.options.find((option) => option.option === chosenOption)
    : undefined;
}

function hasUnknownConfirmedFindingCode(
  record: PreparedReplyRecord,
  decision: PreparedReplyVariantDecision,
): boolean {
  if (decision.confirmedFindingCodes === undefined) {
    return false;
  }

  const variantGroup = record.variantGroup;
  if (variantGroup?.state !== "judge_ready") {
    return true;
  }
  const knownCodes = new Set(variantGroup.findings.map((finding) => finding.code));
  return decision.confirmedFindingCodes.some((code) => !knownCodes.has(code));
}

function resolvePreparedReplySelection(
  record: PreparedReplyRecord,
  resolution: PreparedReplyDecisionResolution,
): PreparedReplySelection {
  const variantGroup = record.variantGroup;
  if (variantGroup === undefined) {
    if (resolution.kind !== "single") {
      return {
        ok: false,
        error: "当前 preparedReplyId 没有双稿选项",
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
  if (variantGroup.state === "not_learned") {
    if (resolution.kind !== "terminal_fallback") {
      return {
        ok: false,
        error: "非学习双稿 preparedReplyId 缺少降级终态",
      };
    }
    return {
      ok: true,
      signedEnvelope: record.signedEnvelope,
      suggestedReply: record.suggestedReply,
      ...(record.unreadCountBeforeReply !== undefined
        ? { unreadCountBeforeReply: record.unreadCountBeforeReply }
        : {}),
      chosenVariant: resolution.chosenVariant,
      decisionSource: resolution.source,
      decisionReason: resolution.reason,
      record,
    };
  }

  if (resolution.kind === "single" || resolution.kind === "terminal_fallback") {
    return { ok: false, error: "双稿 preparedReplyId 缺少选择状态" };
  }
  const decision = resolution.kind === "decision" ? resolution.decision : undefined;
  if (decision !== undefined && hasUnknownConfirmedFindingCode(record, decision)) {
    return {
      ok: false,
      error: "variantDecision.confirmedFindingCodes 必须来自 replyVariantSelection.findings",
    };
  }

  const chosenOption =
    resolution.kind === "decision"
      ? resolution.decision.chosenOption
      : resolution.recommendedOption;
  const option = findVariantOption(record, chosenOption);
  if (option === undefined) {
    return {
      ok: false,
      error: `未找到双稿选项 ${chosenOption}`,
    };
  }

  const decisionReason =
    resolution.kind === "decision" ? resolution.decision.reason : resolution.reason;
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
    decisionSource: resolution.source,
    decisionReason,
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
        selection.decisionSource,
        selection.decisionReason,
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
  ctx: AgentContext,
): Promise<Pick<ZhipinSendPreparedReplyOutput, "feedbackStatus" | "feedbackError">> {
  const variantGroup = selection.record.variantGroup;
  if (variantGroup === undefined) {
    return {};
  }
  if (
    selection.chosenVariant === undefined ||
    selection.decisionSource === undefined ||
    selection.decisionReason === undefined
  ) {
    return {
      feedbackStatus: "failed",
      feedbackError: "Dual-draft send completed without terminal feedback metadata.",
    };
  }

  try {
    let body: ReplyFeedbackBody;
    if (selection.variantDecision !== undefined) {
      if (selection.decisionSource !== "judge" && selection.decisionSource !== "orchestrator") {
        throw new Error("Learning feedback has an invalid decision source.");
      }
      body = {
        groupId: variantGroup.groupId,
        target: variantGroup.target,
        chosenVariant: selection.chosenVariant,
        feedbackOutcome: "selected",
        decisionSource: selection.decisionSource,
        ...(selection.variantDecision.confirmedFindingCodes !== undefined
          ? { confirmedFindingCodes: selection.variantDecision.confirmedFindingCodes }
          : {}),
        reason: selection.variantDecision.reason,
        rubricVersion: variantGroup.rubricVersion,
        rubricHash: variantGroup.rubricHash,
        ...(selection.variantDecision.judgeModel !== undefined
          ? { judgeModel: selection.variantDecision.judgeModel }
          : {}),
      };
    } else {
      if (
        selection.decisionSource !== "service_recommended_fallback" &&
        selection.decisionSource !== "explicit_no_judge"
      ) {
        throw new Error("Non-learning feedback has an invalid decision source.");
      }
      const reason = selection.decisionReason.trim().slice(0, 500);
      body = {
        groupId: variantGroup.groupId,
        target: variantGroup.target,
        chosenVariant: selection.chosenVariant,
        feedbackOutcome: "not_learned",
        decisionSource: selection.decisionSource,
        reason: reason || "Dual-draft learning was intentionally skipped.",
        rubricVersion: variantGroup.rubricVersion,
        rubricHash: variantGroup.rubricHash,
      };
    }
    const result = await deps.submitReplyFeedback(
      body,
      deps.postReplyFeedback,
      ctx.logger,
      variantGroup.feedbackExpiresAt !== undefined
        ? { feedbackExpiresAt: variantGroup.feedbackExpiresAt }
        : {},
    );
    return {
      feedbackStatus: result.status,
      ...(result.error !== undefined ? { feedbackError: result.error } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`Reply feedback outbox failed after sending prepared reply: ${message}`);
    return { feedbackStatus: "failed", feedbackError: message };
  }
}

function decisionOutput(
  selection: Extract<PreparedReplySelection, { ok: true }>,
): Pick<
  ZhipinSendPreparedReplyOutput,
  "chosenOption" | "decisionSource" | "decisionReason" | "judgeModel" | "feedbackExpected"
> {
  if (selection.decisionSource === undefined) {
    return {};
  }
  return {
    ...(selection.chosenOption !== undefined ? { chosenOption: selection.chosenOption } : {}),
    decisionSource: selection.decisionSource,
    ...(selection.decisionReason !== undefined ? { decisionReason: selection.decisionReason } : {}),
    ...(selection.variantDecision?.judgeModel !== undefined
      ? { judgeModel: selection.variantDecision.judgeModel }
      : {}),
    feedbackExpected: selection.variantDecision !== undefined,
  };
}

export const zhipinSendPreparedReply = defineTool<
  ZhipinSendPreparedReplyInput,
  ZhipinSendPreparedReplyOutput
>({
  name: TOOL_NAME,
  description:
    "发送由 zhipin_generate_reply_preview 生成的预备回复；双稿缺少 variantDecision 时会在工具内部自动 Judge，并在发送成功后持久化回传 feedback。",
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
    const resolution = await resolvePreparedReplyDecision(inspected.record, input, ctx);
    if (resolution.kind === "error") {
      return { success: false, sentMessage: "", error: resolution.error };
    }
    const inspectedSelection = resolvePreparedReplySelection(inspected.record, resolution);
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
    const consumedSelection = resolvePreparedReplySelection(consumed.record, resolution);
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
      ...decisionOutput(consumedSelection),
      ...feedbackResult,
    };
  },
});
