/**
 * Public pipeline API — 供外部项目直接 import 使用。
 *
 * @example
 * ```ts
 * import { generateSmartReply } from "@roll-agent/smart-reply-agent/pipeline";
 * import type { SmartReplyAgentOptions, SmartReplyAgentResult } from "@roll-agent/smart-reply-agent/pipeline";
 * ```
 */

// ---- core pipeline ----
export { generateSmartReply } from "./pipeline/smart-reply.ts";
export type {
  SmartReplyAgentOptions,
  SmartReplyAgentResult,
  SmartReplyDebugInfo,
} from "./pipeline/smart-reply.ts";

// ---- types required by SmartReplyAgentOptions ----
export type { ZhipinData, CandidateInfo } from "./types/zhipin.ts";
export type {
  ReplyPolicyConfig,
  ChannelType,
  FunnelStage,
  TurnPlan,
  ReplyNeed,
  EffectiveDisclosureMode,
} from "./types/reply-policy.ts";
export type { BrandPriorityStrategy } from "./types/config.ts";
export type { ProviderConfigs } from "./types/classification.ts";

// ---- types from SmartReplyAgentResult / SmartReplyDebugInfo ----
export type { ReplyGateViolationCode } from "./pipeline/reply-gate.ts";
export type { SafeGenerateTextUsage } from "./ai/structured-output.ts";
export {
  collectAgeEvidenceFromSources,
  createConfigDataAgeSource,
  createDefaultAgeEligibilitySources,
  createDulidayApiAgeSource,
  evaluateAgeEligibility,
} from "./pipeline/age-eligibility.ts";
export type {
  AgeEvidence,
  AgeEvidenceCollection,
  AgeEvidenceSourceResult,
  AgeEligibilityQuery,
  AgeEligibilityResult,
  AgeEligibilitySource,
  AgeEligibilityStatus,
  AgeEligibilityAppliedStrategy,
  AgeEligibilitySummary,
} from "./pipeline/age-eligibility.ts";
export type { StoreWithDistance } from "./types/geocoding.ts";
export type { AppError } from "./errors/index.ts";
