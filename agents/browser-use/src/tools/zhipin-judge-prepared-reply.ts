import { defineTool, type AgentContext } from "@roll-agent/sdk";
import {
  fetchReplyFeedbackRubric,
  type ReplyFeedbackRubricResponse,
  type ReplyGateAdvisoryCode,
} from "@roll-agent/reply-authority-client";
import { z } from "zod";
import {
  JudgeModelOutputSchema,
  PreparedReplyFallbackReasons,
  PreparedReplySendDecisionSourceValues,
  PreparedReplyVariantDecisionSchema,
  type PreparedReplyFallbackReason,
  type PreparedReplyJudgement,
} from "../reply-authority/prepared-reply-decision.ts";
import { redactPreparedReplyJudgeText } from "../reply-authority/prepared-reply-judge-context.ts";
import {
  inspectPreparedReply,
  PreparedReplyOptionValues,
  setPreparedReplyJudgement,
  type PreparedReplyRecord,
} from "../reply-authority/prepared-reply-store.ts";

const TOOL_NAME = "zhipin_judge_prepared_reply";

const OutputSchema = z.object({
  success: z.boolean(),
  variantDecision: PreparedReplyVariantDecisionSchema.optional(),
  decisionSource: z.enum(PreparedReplySendDecisionSourceValues).optional(),
  fallback: z.boolean().optional(),
  recommendedOption: z.enum(PreparedReplyOptionValues).optional(),
  error: z.string().optional(),
});

const InputSchema = z.object({
  preparedReplyId: z
    .string()
    .min(1)
    .describe("zhipin_generate_reply_preview 返回的 preparedReplyId"),
  judgeModel: z
    .string()
    .min(1)
    .optional()
    .describe("写入 feedback 审计的模型标签；不会改变实际 MCP Sampling 模型"),
});

type ZhipinJudgePreparedReplyDeps = {
  readonly fetchReplyFeedbackRubric: typeof fetchReplyFeedbackRubric;
};

let zhipinJudgePreparedReplyDepsOverride: Partial<ZhipinJudgePreparedReplyDeps> | undefined;
const pendingJudgements = new Map<string, Promise<PreparedReplyJudgement>>();

function getZhipinJudgePreparedReplyDeps(): ZhipinJudgePreparedReplyDeps {
  return {
    fetchReplyFeedbackRubric,
    ...zhipinJudgePreparedReplyDepsOverride,
  };
}

export function setZhipinJudgePreparedReplyDepsForTests(
  override: Partial<ZhipinJudgePreparedReplyDeps> | undefined,
): void {
  zhipinJudgePreparedReplyDepsOverride = override;
  pendingJudgements.clear();
}

function formatPreparedReplyError(reason: "not_found" | "expired" | "consumed"): string {
  if (reason === "expired") {
    return "preparedReplyId 已过期，请重新生成回复";
  }
  if (reason === "consumed") {
    return "preparedReplyId 已消费，禁止重复 judge";
  }
  return "preparedReplyId 不存在，请重新生成回复";
}

function buildFallback(
  record: PreparedReplyRecord,
  reason: PreparedReplyFallbackReason,
): PreparedReplyJudgement {
  const variantGroup = record.variantGroup;
  if (variantGroup?.state !== "judge_ready") {
    throw new Error("preparedReplyId 未包含双稿选项");
  }
  return {
    kind: "fallback",
    source: "service_recommended_fallback",
    recommendedOption: variantGroup.recommendedOption,
    reason,
  };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("judge 输出不是 JSON 对象");
  }
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

function validateConfirmedCodes(
  record: PreparedReplyRecord,
  confirmedFindingCodes: readonly ReplyGateAdvisoryCode[],
): boolean {
  const variantGroup = record.variantGroup;
  if (variantGroup?.state !== "judge_ready") {
    return false;
  }
  const knownCodes = new Set(variantGroup.findings.map((finding) => finding.code));
  return confirmedFindingCodes.every((code) => knownCodes.has(code));
}

function buildJudgePrompt(
  record: PreparedReplyRecord,
  rubric: ReplyFeedbackRubricResponse,
): string {
  const variantGroup = record.variantGroup;
  if (variantGroup?.state !== "judge_ready") {
    throw new Error("preparedReplyId 未包含双稿选项");
  }

  return [
    "你是招聘回复双稿 judge。请只比较中性选项 option_1 / option_2，不要推断内部稿件身份。",
    "两份 option 均已通过 Reply Authority 的事实硬门并完成签名；不得自行补充、改写或推断岗位事实。",
    "请结合 candidateContext、当前回复阶段和冻结 rubric，比较目标贴合、合规、事实安全、语气、转化意图、候选人体验、简洁度与回归风险。",
    "reason 必须指出候选人当前目标、胜出选项的具体优势，以及另一选项的具体不足；禁止只写“更好”“更自然”等空泛结论。",
    "reason 不得复述姓名、电话、微信号、candidateId、conversationId 或大段候选人原话。",
    "输出必须是 JSON 对象，且只包含：chosenOption、reason、confirmedFindingCodes。",
    "confirmedFindingCodes 必须显式返回且只能来自 findings.code；只有逐项核实全部为误报时才返回空数组，禁止因不确定而省略。",
    "confirmedFindingCodes 与 chosenOption 相互独立：只要某个 finding 指出的问题在任一 option 文本中真实存在，就必须勾选该 code，哪怕最终选择了包含该问题的 option。",
    "若两稿差异很小，仍选择整体风险更低的一稿，并在 reason 中说明关键取舍。",
    "",
    `stage: ${record.stage}`,
    `candidateContext: ${JSON.stringify(variantGroup.judgeContext ?? null)}`,
    `rubricVersion: ${variantGroup.rubricVersion}`,
    `rubricHash: ${variantGroup.rubricHash}`,
    `rubric: ${JSON.stringify(rubric.rubric)}`,
    `advisoryFindings: ${JSON.stringify(rubric.advisoryFindings)}`,
    `findings: ${JSON.stringify(variantGroup.findings)}`,
    `options: ${JSON.stringify(
      variantGroup.options.map((option) => ({
        option: option.option,
        suggestedReply: option.suggestedReply,
      })),
    )}`,
  ].join("\n");
}

async function evaluatePreparedReply(
  record: PreparedReplyRecord,
  ctx: AgentContext,
  judgeModel: string,
): Promise<PreparedReplyJudgement> {
  const variantGroup = record.variantGroup;
  if (variantGroup?.state !== "judge_ready") {
    throw new Error("preparedReplyId 未包含双稿选项");
  }

  const deps = getZhipinJudgePreparedReplyDeps();
  let rubric: ReplyFeedbackRubricResponse;
  try {
    rubric = await deps.fetchReplyFeedbackRubric({
      tenantId: variantGroup.target.tenantId,
      rubricVersion: variantGroup.rubricVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(
      `Default dual-draft judge failed: ` +
        `reason=${PreparedReplyFallbackReasons.RUBRIC_FETCH_FAILED} detail=${message}`,
    );
    return buildFallback(record, PreparedReplyFallbackReasons.RUBRIC_FETCH_FAILED);
  }
  if (
    rubric.rubricVersion !== variantGroup.rubricVersion ||
    rubric.rubricHash !== variantGroup.rubricHash
  ) {
    return buildFallback(record, PreparedReplyFallbackReasons.RUBRIC_MISMATCH);
  }

  let text: string;
  try {
    text = await ctx.llm.generateText(buildJudgePrompt(record, rubric));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(
      `Default dual-draft judge failed: ` +
        `reason=${PreparedReplyFallbackReasons.JUDGE_SAMPLING_FAILED} detail=${message}`,
    );
    return buildFallback(record, PreparedReplyFallbackReasons.JUDGE_SAMPLING_FAILED);
  }

  let parsed: z.infer<typeof JudgeModelOutputSchema>;
  try {
    parsed = JudgeModelOutputSchema.parse(extractJsonObject(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(
      `Default dual-draft judge failed: ` +
        `reason=${PreparedReplyFallbackReasons.JUDGE_OUTPUT_INVALID} detail=${message}`,
    );
    return buildFallback(record, PreparedReplyFallbackReasons.JUDGE_OUTPUT_INVALID);
  }
  if (!validateConfirmedCodes(record, parsed.confirmedFindingCodes)) {
    ctx.logger.warn(
      `Default dual-draft judge failed: ` +
        `reason=${PreparedReplyFallbackReasons.JUDGE_OUTPUT_INVALID} detail=unknown finding code`,
    );
    return buildFallback(record, PreparedReplyFallbackReasons.JUDGE_OUTPUT_INVALID);
  }

  return {
    kind: "decision",
    source: "judge",
    decision: {
      chosenOption: parsed.chosenOption,
      reason: redactPreparedReplyJudgeText(parsed.reason),
      confirmedFindingCodes: parsed.confirmedFindingCodes,
      judgeModel,
    },
  };
}

export async function ensurePreparedReplyJudgement(
  record: PreparedReplyRecord,
  ctx: AgentContext,
  judgeModel = "mcp-sampling",
): Promise<PreparedReplyJudgement> {
  if (record.variantGroup?.state !== "judge_ready") {
    throw new Error("preparedReplyId 未包含双稿选项");
  }
  if (record.judgement !== undefined) {
    return record.judgement;
  }

  const existing = pendingJudgements.get(record.preparedReplyId);
  if (existing !== undefined) {
    return existing;
  }

  const pending = evaluatePreparedReply(record, ctx, judgeModel)
    .then((judgement) => {
      const updated = setPreparedReplyJudgement(record.preparedReplyId, judgement);
      if (!updated.ok) {
        ctx.logger.warn(
          `Failed to cache dual-draft judgement for ${record.preparedReplyId}: ${updated.reason}`,
        );
      }
      return judgement;
    })
    .finally(() => {
      pendingJudgements.delete(record.preparedReplyId);
    });
  pendingJudgements.set(record.preparedReplyId, pending);
  return pending;
}

function toOutput(judgement: PreparedReplyJudgement): z.infer<typeof OutputSchema> {
  if (judgement.kind === "decision") {
    return {
      success: true,
      variantDecision: judgement.decision,
      decisionSource: judgement.source,
    };
  }
  return {
    success: true,
    fallback: true,
    recommendedOption: judgement.recommendedOption,
    decisionSource: judgement.source,
    error: judgement.reason,
  };
}

export const zhipinJudgePreparedReply = defineTool({
  name: TOOL_NAME,
  description:
    "对 zhipin_generate_reply_preview 返回的双稿 preparedReplyId 执行默认 judge；结果会缓存供发送复用。Judge 失败时返回稳定安全码并降级为推荐稿，发送阶段回传 not_learned 终态但不产生学习样本。",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const inspected = inspectPreparedReply(input.preparedReplyId);
    if (!inspected.ok) {
      return {
        success: false,
        error: formatPreparedReplyError(inspected.reason),
      };
    }
    if (inspected.record.variantGroup === undefined) {
      return {
        success: false,
        error: "preparedReplyId 未包含双稿选项，无需 judge",
      };
    }
    if (inspected.record.variantGroup.state === "not_learned") {
      return OutputSchema.parse({
        success: true,
        fallback: true,
        decisionSource: "service_recommended_fallback",
        error: inspected.record.variantGroup.reason,
      });
    }

    const judgement = await ensurePreparedReplyJudgement(
      inspected.record,
      ctx,
      input.judgeModel ?? "mcp-sampling",
    );
    return toOutput(judgement);
  },
});
