import { ReplyGateAdvisoryCodeSchema } from "@roll-agent/reply-authority-client";
import { z } from "zod";

export const PreparedReplyOptionValues = ["option_1", "option_2"] as const;
export const PreparedReplyDecisionSourceValues = ["judge", "orchestrator"] as const;
export const PreparedReplySendDecisionSourceValues = [
  ...PreparedReplyDecisionSourceValues,
  "service_recommended_fallback",
  "explicit_no_judge",
] as const;

export const PreparedReplyFallbackReasons = {
  RUBRIC_FETCH_FAILED: "rubric_fetch_failed",
  RUBRIC_MISMATCH: "rubric_mismatch",
  INVALID_VARIANT_SHAPE: "invalid_variant_shape",
  JUDGE_SAMPLING_FAILED: "judge_sampling_failed",
  JUDGE_OUTPUT_INVALID: "judge_output_invalid",
} as const;

const ConfirmedFindingCodesSchema = z
  .array(ReplyGateAdvisoryCodeSchema)
  .max(4)
  .refine((codes) => new Set(codes).size === codes.length, {
    message: "confirmedFindingCodes 不能包含重复 code",
  });

export const PreparedReplyVariantDecisionSchema = z.object({
  chosenOption: z
    .enum(PreparedReplyOptionValues)
    .describe("从 replyVariantSelection.options 中选择的中性选项"),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("结合候选人当前问题和 rubric，说明选择该选项的具体理由"),
  confirmedFindingCodes: ConfirmedFindingCodesSchema.optional().describe(
    "确认属实的 replyVariantSelection.findings code；显式空数组表示 findings 均为误报",
  ),
  judgeModel: z.string().trim().min(1).optional().describe("执行 judge 的模型审计标签"),
});

export const JudgeModelOutputSchema = PreparedReplyVariantDecisionSchema.omit({
  judgeModel: true,
}).extend({
  confirmedFindingCodes: ConfirmedFindingCodesSchema.describe(
    "必须显式返回；空数组仅表示已核实当前 findings 均为误报",
  ),
});

export type PreparedReplyOption = (typeof PreparedReplyOptionValues)[number];
export type PreparedReplyDecisionSource = (typeof PreparedReplyDecisionSourceValues)[number];
export type PreparedReplySendDecisionSource =
  (typeof PreparedReplySendDecisionSourceValues)[number];
export type PreparedReplyFallbackReason =
  (typeof PreparedReplyFallbackReasons)[keyof typeof PreparedReplyFallbackReasons];
export type PreparedReplyVariantDecision = z.infer<typeof PreparedReplyVariantDecisionSchema>;

export type PreparedReplyJudgement =
  | {
      readonly kind: "decision";
      readonly source: PreparedReplyDecisionSource;
      readonly decision: PreparedReplyVariantDecision;
    }
  | {
      readonly kind: "fallback";
      readonly source: "service_recommended_fallback";
      readonly recommendedOption: PreparedReplyOption;
      readonly reason: PreparedReplyFallbackReason;
    };
