import { defineTool } from "@roll-agent/sdk";
import {
  fetchReplyFeedbackRubric,
  ReplyGateAdvisoryCodeSchema,
  type ReplyFeedbackRubricResponse,
  type ReplyGateAdvisoryCode,
} from "@roll-agent/reply-authority-client";
import { z } from "zod";
import {
  inspectPreparedReply,
  PreparedReplyOptionValues,
  type PreparedReplyRecord,
} from "../reply-authority/prepared-reply-store.ts";

const TOOL_NAME = "zhipin_judge_prepared_reply";

const VariantDecisionSchema = z.object({
  chosenOption: z.enum(PreparedReplyOptionValues),
  reason: z.string().min(1).max(500),
  confirmedFindingCodes: z.array(ReplyGateAdvisoryCodeSchema).optional(),
  judgeModel: z.string().min(1).optional(),
});

const JudgeModelOutputSchema = z.object({
  chosenOption: z.enum(PreparedReplyOptionValues),
  reason: z.string().min(1).max(500),
  confirmedFindingCodes: z.array(ReplyGateAdvisoryCodeSchema).default([]),
});

const OutputSchema = z.object({
  success: z.boolean(),
  variantDecision: VariantDecisionSchema.optional(),
  fallback: z.boolean().optional(),
  recommendedOption: z.enum(PreparedReplyOptionValues).optional(),
  error: z.string().optional(),
});

const InputSchema = z.object({
  preparedReplyId: z
    .string()
    .min(1)
    .describe("zhipin_generate_reply_preview 返回的 preparedReplyId"),
  judgeModel: z.string().min(1).optional().describe("写入 feedback 审计的 judge 模型 ID"),
});

type ZhipinJudgePreparedReplyDeps = {
  readonly fetchReplyFeedbackRubric: typeof fetchReplyFeedbackRubric;
};

let zhipinJudgePreparedReplyDepsOverride: Partial<ZhipinJudgePreparedReplyDeps> | undefined;

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

function buildFallback(record: PreparedReplyRecord, error: string): z.infer<typeof OutputSchema> {
  return {
    success: true,
    fallback: true,
    recommendedOption: record.variantGroup?.recommendedOption,
    error,
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
  const knownCodes = new Set(record.variantGroup?.findings.map((finding) => finding.code) ?? []);
  return confirmedFindingCodes.every((code) => knownCodes.has(code));
}

function buildJudgePrompt(
  record: PreparedReplyRecord,
  rubric: ReplyFeedbackRubricResponse,
): string {
  const variantGroup = record.variantGroup;
  if (variantGroup === undefined) {
    throw new Error("preparedReplyId 未包含双稿选项");
  }

  return [
    "你是招聘回复双稿 judge。请只比较中性选项 option_1 / option_2，不要推断 draft/revised。",
    "目标：选择更适合发送给候选人的回复，并核实 findings 中哪些问题确实成立。",
    "输出必须是 JSON 对象，字段：chosenOption、reason、confirmedFindingCodes。",
    "confirmedFindingCodes 只能来自 findings.code；如果 findings 是误报，返回空数组。",
    "confirmedFindingCodes 与 chosenOption 相互独立：只要某个 finding 指出的问题在任一 option 文本中真实存在，就必须勾选该 code，哪怕你最终选择了包含该问题的 option。",
    "",
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

export const zhipinJudgePreparedReply = defineTool({
  name: TOOL_NAME,
  description:
    "对 zhipin_generate_reply_preview 返回的双稿 preparedReplyId 执行默认 judge；成功时返回可传给 zhipin_send_prepared_reply 的 variantDecision，失败时降级为推荐稿且不回传 feedback。",
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

    const deps = getZhipinJudgePreparedReplyDeps();
    const variantGroup = inspected.record.variantGroup;
    try {
      const rubric = await deps.fetchReplyFeedbackRubric({
        tenantId: variantGroup.target.tenantId,
        rubricVersion: variantGroup.rubricVersion,
      });
      if (
        rubric.rubricVersion !== variantGroup.rubricVersion ||
        rubric.rubricHash !== variantGroup.rubricHash
      ) {
        return buildFallback(inspected.record, "rubric version/hash 不匹配，降级发送推荐稿");
      }

      const text = await ctx.llm.generateText(buildJudgePrompt(inspected.record, rubric));
      const parsed = JudgeModelOutputSchema.parse(extractJsonObject(text));
      if (!validateConfirmedCodes(inspected.record, parsed.confirmedFindingCodes)) {
        return buildFallback(inspected.record, "judge confirmedFindingCodes 不属于当前 findings");
      }

      return {
        success: true,
        variantDecision: {
          chosenOption: parsed.chosenOption,
          reason: parsed.reason,
          confirmedFindingCodes: parsed.confirmedFindingCodes,
          judgeModel: input.judgeModel ?? "mcp-sampling",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`Default dual-draft judge failed: ${message}`);
      return buildFallback(inspected.record, message);
    }
  },
});
