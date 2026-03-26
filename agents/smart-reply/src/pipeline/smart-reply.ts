import {
  getDynamicRegistry,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_PROVIDER_CONFIGS,
} from "../ai/model-registry.ts";
import type { ModelId } from "../ai/model-registry.ts";
import {
  getAllStores,
  getAvailableBrandNames,
  resolveDefaultBrandName,
  resolvePrimaryCity,
} from "../services/brand-config-selectors.ts";
import type { ZhipinData, CandidateInfo } from "../types/zhipin.ts";
import type { BrandPriorityStrategy } from "../types/config.ts";
import type { StoreWithDistance } from "../types/geocoding.ts";
import type {
  TurnPlan,
  ReplyNeed,
  FunnelStage,
  ChannelType,
  ReplyPolicyConfig,
  EffectiveDisclosureMode,
} from "../types/reply-policy.ts";
import { PRIMARY_NEED_FACT_MAP } from "../types/reply-policy.ts";
import type { ProviderConfigs } from "../types/classification.ts";
import { planTurn, selectContextNeeds } from "./classification.ts";
import { buildContextInfoByNeeds } from "./context-builder.ts";
import {
  detectConcreteFactFamilies,
  detectContextFactFamilies,
  validateReply,
  type ReplyGateViolationCode,
} from "./reply-gate.ts";
import { safeGenerateText } from "../ai/structured-output.ts";
import type { SafeGenerateTextUsage } from "../ai/structured-output.ts";
import { logError } from "../errors/index.ts";
import type { AppError } from "../errors/index.ts";
import { setSuppressVerboseLogs } from "../log-control.ts";
import { createPipelineProgress } from "./pipeline-progress.ts";
import type { PipelineProgress } from "./pipeline-progress.ts";
import { evaluateAgeEligibility } from "./age-eligibility.ts";
import type {
  AgeEligibilityAppliedStrategy,
  AgeEligibilityResult,
  AgeEligibilityStatus,
  AgeEligibilitySummary,
} from "./age-eligibility.ts";
import { resolveCandidateAge, resolveRegionName } from "./candidate-utils.ts";
import { buildKnownCandidateContext } from "./candidate-context.ts";
import type { KnownCandidateContext } from "./candidate-context.ts";

export interface SmartReplyAgentOptions {
  modelConfig?:
    | {
        chatModel?: string | undefined;
        classifyModel?: string | undefined;
        replyModel?: string | undefined;
        providerConfigs?: ProviderConfigs | undefined;
      }
    | undefined;
  preferredBrand?: string | undefined;
  toolBrand?: string | undefined;
  brandPriorityStrategy?: BrandPriorityStrategy | undefined;
  conversationHistory?: string[] | undefined;
  candidateMessage: string;
  configData: ZhipinData;
  replyPolicy?: ReplyPolicyConfig | undefined;
  candidateInfo?: CandidateInfo | undefined;
  defaultWechatId?: string | undefined;
  industryVoiceId?: string | undefined;
  channelType?: ChannelType | undefined;
  turnIndex?: number | undefined;
}

export interface SmartReplyDebugInfo {
  relevantStores: StoreWithDistance[];
  storeCount: number;
  detailLevel: EffectiveDisclosureMode;
  resolvedBrand: string;
  turnPlan: TurnPlan;
  turnIndex: number;
  effectiveDisclosureMode: EffectiveDisclosureMode;
  primaryNeed: ReplyNeed;
  replyGateRewritten: boolean;
  gateViolations: ReplyGateViolationCode[];
  aliasLookupError?: string | undefined;
  gateStatus: AgeEligibilityStatus;
  appliedStrategy: AgeEligibilityAppliedStrategy;
  ageRangeSummary: AgeEligibilitySummary;
}

export interface SmartReplyAgentResult {
  turnPlan: TurnPlan;
  suggestedReply: string;
  confidence: number;
  shouldExchangeWechat?: boolean | undefined;
  factGateRewritten: boolean;
  replyGateRewritten: boolean;
  gateViolations: ReplyGateViolationCode[];
  contextInfo?: string | undefined;
  debugInfo?: SmartReplyDebugInfo | undefined;
  usage: SafeGenerateTextUsage | undefined;
  latencyMs?: number | undefined;
  error?: AppError | undefined;
}

function formatAgeRange(summary: AgeEligibilitySummary): string | null {
  if (summary.minAgeObserved === null && summary.maxAgeObserved === null) return null;
  const min = summary.minAgeObserved ?? "?";
  const max = summary.maxAgeObserved ?? "?";
  return `${min}-${max}`;
}

function buildAgeQualificationConstraints(
  eligibility: AgeEligibilityResult | undefined,
  policy: ReplyPolicyConfig | undefined,
  turnPlan: TurnPlan,
): string[] {
  const agePolicy = policy?.qualificationPolicy?.age;
  if (!eligibility || !agePolicy || !agePolicy.enabled) return [];
  if (eligibility.status === "unknown" && !turnPlan.riskFlags.includes("age_sensitive")) return [];

  const lines: string[] = ["[QualificationPolicy:Age]"];
  const rangeText = formatAgeRange(eligibility.summary);

  lines.push(`- gateStatus: ${eligibility.status}`);
  lines.push(`- expressionStrategy: ${eligibility.appliedStrategy.strategy}`);
  lines.push(
    `- redirect: ${agePolicy.allowRedirect ? `allowed priority=${agePolicy.redirectPriority}` : "not allowed"}`,
  );
  lines.push(`- revealRange: ${agePolicy.revealRange ? "allowed" : "not allowed"}`);
  if (agePolicy.revealRange && rangeText) lines.push(`- rangeObserved: ${rangeText}`);

  if (eligibility.status === "pass") {
    lines.push(
      `- writingConstraint: ${eligibility.appliedStrategy.strategy}；匹配通过后推进下一步，避免强调年龄筛选`,
    );
  } else if (eligibility.status === "fail") {
    lines.push(
      `- writingConstraint: ${eligibility.appliedStrategy.strategy}；礼貌说明不匹配，避免承诺或争辩`,
    );
    if (agePolicy.allowRedirect) lines.push("- writingConstraint: 可提示其他岗位或门店选项");
  } else {
    lines.push(
      `- writingConstraint: 如确需涉及年龄或资格，用合规、轻量的方式核实，不要审查式逐条盘问`,
    );
  }

  return lines;
}

function buildPolicyPrompt(
  policy: ReplyPolicyConfig | undefined,
  turnPlan: TurnPlan,
  contextNeeds: ReplyNeed[],
  contextInfo: string,
  message: string,
  conversationHistory: string[],
  turnIndex: number,
  effectiveDisclosureMode: EffectiveDisclosureMode,
  knownCandidate: KnownCandidateContext,
  industryVoiceId?: string,
  defaultWechatId?: string,
  ageEligibility?: AgeEligibilityResult,
): { system: string; prompt: string } {
  if (!policy) {
    return {
      system: "你是招聘助手。遵循事实，不夸大承诺，回复简洁自然。",
      prompt: `候选人消息：${message}\n\n上下文：\n${contextInfo}\n\n请直接回复候选人。`,
    };
  }

  const stagePolicy = policy.stageGoals[turnPlan.stage];
  const voice = policy.industryVoices[industryVoiceId || policy.defaultIndustryVoiceId];
  const maxQuestions = policy.outputGuards.maxQuestionsByMode[effectiveDisclosureMode];

  const system = [
    "你是政策驱动的招聘助手。",
    `当前阶段：${turnPlan.stage}`,
    `当前轮次：${turnIndex}`,
    `当前披露模式：${effectiveDisclosureMode}`,
    `主回答轴：${turnPlan.primaryNeed}`,
    `阶段目标：${stagePolicy.primaryGoal}`,
    `阶段成功标准：${stagePolicy.successCriteria.join("；")}`,
    `推进策略：${stagePolicy.ctaStrategy}`,
    stagePolicy.disallowedActions?.length
      ? `阶段禁止：${stagePolicy.disallowedActions.join("；")}`
      : "",
    `人格设定：语气=${policy.persona.tone}，亲和度=${policy.persona.warmth}，长度=${policy.persona.length}，称呼=${policy.persona.addressStyle}，提问风格=${policy.persona.questionStyle}`,
    `共情策略：${policy.persona.empathyStrategy}`,
    voice
      ? `行业指纹：${voice.name}；背景=${voice.industryBackground}；行业词=${voice.jargon.join("、")}；避免=${voice.tabooPhrases.join("、")}`
      : "",
    `红线规则：${policy.hardConstraints.rules.map((r) => r.rule).join("；")}`,
    `FactGate模式：${policy.factGate.mode}；缺事实回退=${policy.factGate.fallbackBehavior}`,
    `禁止审查措辞：${policy.outputGuards.blockedAuditPhrases.join("、")}`,
    ...(knownCandidate.knownFieldNames.length > 0
      ? [`候选人资料已确认：${knownCandidate.knownFieldNames.join("、")}。这些信息不得重复追问；如需引用，自然带过即可，不要像念资料一样复述。`]
      : []),
    ...buildAgeQualificationConstraints(ageEligibility, policy, turnPlan),
    defaultWechatId
      ? `如涉及换微信，优先引导平台交换，必要时可提供默认微信号：${defaultWechatId}`
      : "如涉及换微信，优先引导平台交换，不编造联系方式。",
    "必须口语化、简洁，不输出解释。",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `[回合规划]`,
    `stage=${turnPlan.stage}`,
    `subGoals=${turnPlan.subGoals.join("、") || "无"}`,
    `contextNeeds=${contextNeeds.join("、") || "none"}`,
    `primaryNeed=${turnPlan.primaryNeed}`,
    `riskFlags=${turnPlan.riskFlags.join("、") || "无"}`,
    `confidence=${turnPlan.confidence.toFixed(2)}`,
    "",
    `[对话历史]`,
    conversationHistory.slice(-6).join("\n") || "无",
    "",
    `[业务上下文]`,
    contextInfo,
    "",
    ...(knownCandidate.factsText
      ? [`[候选人已知信息]`, knownCandidate.factsText, ""]
      : []),
    `[候选人消息]`,
    message,
    "",
    `[输出要求]`,
    "1. 直接给候选人的单条回复。",
    "2. 不得输出多段解释或元信息。",
    "3. 围绕 primaryNeed 回答，不主动展开其他事实轴。",
    `4. 最多追问 ${maxQuestions} 个关键问题。`,
    "5. 首轮优先泛化回答，不主动抛具体数字、时间、地址或筛选条件。",
    "6. 禁止使用“是否满足”“是否符合”“基本入职要求”等审查措辞。",
    "7. 若候选人同时问两个点，只在上下文支持时简要带上次要问题；没有事实时只做泛化承接，不编造细节。",
  ].join("\n");

  return { system, prompt };
}

export function hasUnsupportedFactClaims(
  text: string,
  contextInfo: string,
  allowedNeeds: ReplyNeed[],
): boolean {
  const claimFamilies = detectConcreteFactFamilies(text);
  if (claimFamilies.length === 0) return false;

  const contextFamilies = new Set(detectContextFactFamilies(contextInfo));
  const allowedFamilies = new Set(allowedNeeds.flatMap((need) => PRIMARY_NEED_FACT_MAP[need]));

  return claimFamilies.some((family) => !allowedFamilies.has(family) || !contextFamilies.has(family));
}

function shouldExchangeWechatByStage(stage: FunnelStage): boolean {
  return stage === "private_channel" || stage === "interview_scheduling";
}

export function resolveTurnIndex(
  conversationHistory: string[],
  explicitTurnIndex?: number | undefined,
): number {
  if (Number.isInteger(explicitTurnIndex) && explicitTurnIndex !== undefined && explicitTurnIndex >= 1) {
    return explicitTurnIndex;
  }
  return conversationHistory.length === 0 ? 1 : 2;
}

export function resolveEffectiveDisclosureMode(
  turnIndex: number,
  stage: FunnelStage,
): EffectiveDisclosureMode {
  if (turnIndex === 1 || stage === "trust_building" || stage === "private_channel") {
    return "minimal";
  }
  return "focused";
}

function buildReplyGateFixInstructions(
  violations: ReplyGateViolationCode[],
  maxQuestions: number,
): string[] {
  const instructions: string[] = ["- 只修正命中的违规点，没有命中的部分不要过度改写。"];

  if (violations.includes("too_many_questions")) {
    instructions.push(`- 删除多余追问，只保留最关键的 ${maxQuestions} 个问题。`);
  }
  if (violations.includes("audit_tone")) {
    instructions.push("- 保留原意，但把审查式措辞改成自然口语，不要像筛选候选人。");
  }
  if (violations.includes("premature_numeric_disclosure")) {
    instructions.push("- 把具体数字、时间和地址细节改成泛化表达，例如“细节我帮你确认”或“以门店安排为准”。");
  }
  if (violations.includes("off_axis_fact_disclosure")) {
    instructions.push("- 删除不属于主回答轴的具体事实；如果要提到次要问题，只能做不带细节的承接。");
  }
  if (violations.includes("reply_overpacked")) {
    instructions.push("- 压缩成最多两句，不要列表、不要枚举、不要一口气展开太多信息。");
  }

  return instructions;
}

async function rewriteForFactGate(
  text: string,
  model: ReturnType<ReturnType<typeof getDynamicRegistry>["languageModel"]>,
  contextInfo: string,
): Promise<{
  text: string;
  usage?: SafeGenerateTextUsage | undefined;
  latencyMs?: number | undefined;
}> {
  const rewritePrompt = [
    "请重写下面这条招聘回复。",
    "要求：",
    "- 不新增任何具体数字、地址、福利承诺。",
    "- 仅保留泛化表达，强调可进一步沟通确认细节。",
    "- 口语化、单行、简洁。",
    "",
    "[原回复]",
    text,
    "",
    "[可用上下文]",
    contextInfo,
  ].join("\n");

  const rewritten = await safeGenerateText({
    model,
    prompt: rewritePrompt,
    context: "SmartReplyFactGateRewrite",
    timeoutMs: 20_000,
    maxOutputTokens: 500,
  });

  if (!rewritten.success) return { text };
  return { text: rewritten.text, usage: rewritten.usage, latencyMs: rewritten.latencyMs };
}

async function rewriteForReplyGate(
  text: string,
  model: ReturnType<ReturnType<typeof getDynamicRegistry>["languageModel"]>,
  contextInfo: string,
  options: {
    turnIndex: number;
    effectiveDisclosureMode: EffectiveDisclosureMode;
    primaryNeed: ReplyNeed;
    allowedNeeds?: ReplyNeed[] | undefined;
    violations: ReplyGateViolationCode[];
    policy?: ReplyPolicyConfig | undefined;
  },
): Promise<{
  text: string;
  usage?: SafeGenerateTextUsage | undefined;
  latencyMs?: number | undefined;
}> {
  const { turnIndex, effectiveDisclosureMode, primaryNeed, allowedNeeds, violations, policy } = options;
  const maxQuestions = policy?.outputGuards.maxQuestionsByMode[effectiveDisclosureMode] ?? 1;
  const blockedPhrases = policy?.outputGuards.blockedAuditPhrases.join("、") ?? "";
  const fixInstructions = buildReplyGateFixInstructions(violations, maxQuestions);
  const secondaryNeeds = (allowedNeeds ?? []).filter((need) => need !== primaryNeed && need !== "none");
  const rewritePrompt = [
    "请重写下面这条招聘回复。",
    "要求：",
    `- 当前轮次=${turnIndex}，披露模式=${effectiveDisclosureMode}，主回答轴=${primaryNeed}。`,
    secondaryNeeds.length > 0 ? `- 允许顺带覆盖的次要轴：${secondaryNeeds.join("、")}。` : "",
    `- 当前违规点：${violations.join("、")}。`,
    ...fixInstructions,
    "- 只保留单条口语化回复，不输出解释。",
    `- 问题数最多 ${maxQuestions} 个。`,
    "- 围绕主回答轴回答，不主动展开其他事实轴。",
    "- 首轮时不要主动报具体数字、时间、地址或筛选条件。",
    blockedPhrases ? `- 禁止使用这些措辞：${blockedPhrases}。` : "",
    "",
    "[原回复]",
    text,
    "",
    "[可用上下文]",
    contextInfo,
  ]
    .filter(Boolean)
    .join("\n");

  const rewritten = await safeGenerateText({
    model,
    prompt: rewritePrompt,
    context: "SmartReplyReplyGateRewrite",
    timeoutMs: 20_000,
    maxOutputTokens: 500,
  });

  if (!rewritten.success) return { text };
  return { text: rewritten.text, usage: rewritten.usage, latencyMs: rewritten.latencyMs };
}

export async function generateSmartReply(
  options: SmartReplyAgentOptions,
): Promise<SmartReplyAgentResult> {
  const progress = createPipelineProgress();
  setSuppressVerboseLogs(true);

  try {
    return await generateSmartReplyInner(options, progress);
  } catch (error) {
    progress.fail("回复生成失败");
    throw error;
  } finally {
    setSuppressVerboseLogs(false);
  }
}

async function generateSmartReplyInner(
  options: SmartReplyAgentOptions,
  progress: PipelineProgress,
): Promise<SmartReplyAgentResult> {
  const {
    modelConfig,
    preferredBrand,
    toolBrand,
    brandPriorityStrategy,
    conversationHistory = [],
    candidateMessage,
    configData,
    replyPolicy,
    candidateInfo,
    defaultWechatId,
    industryVoiceId,
    channelType,
    turnIndex,
  } = options;

  const providerConfigs = modelConfig?.providerConfigs || DEFAULT_PROVIDER_CONFIGS;
  const primaryCity = resolvePrimaryCity(configData);
  const brandData = {
    ...(primaryCity ? { city: primaryCity } : {}),
    defaultBrand: resolveDefaultBrandName(configData),
    availableBrands: getAvailableBrandNames(configData),
    storeCount: getAllStores(configData).length,
  };
  const knownCandidate = buildKnownCandidateContext(candidateInfo);

  progress.update("分析对话意图...");
  const turnPlan = await planTurn(candidateMessage, {
    modelConfig: modelConfig || {},
    conversationHistory,
    brandData,
    providerConfigs,
    ...(channelType !== undefined ? { channelType } : {}),
    ...(replyPolicy !== undefined ? { replyPolicy } : {}),
    ...(knownCandidate.knownFieldNames.length > 0
      ? { knownCandidateFields: knownCandidate.knownFieldNames }
      : {}),
  });
  const resolvedTurnIndex = resolveTurnIndex(conversationHistory, turnIndex);
  const effectiveDisclosureMode = resolveEffectiveDisclosureMode(resolvedTurnIndex, turnPlan.stage);
  const contextNeeds =
    effectiveDisclosureMode === "focused"
      ? selectContextNeeds(turnPlan.primaryNeed, turnPlan.needs, candidateMessage, 2)
      : [turnPlan.primaryNeed];

  // toolBrand 优先；fallback 到 LLM 从消息中提取的 mentionedBrand
  const effectiveToolBrand = toolBrand || turnPlan.extractedInfo.mentionedBrand || undefined;

  progress.update("构建业务上下文...");
  const { contextInfo, debugInfo, resolvedBrand } = await buildContextInfoByNeeds(
    configData,
    turnPlan,
    preferredBrand,
    effectiveToolBrand,
    brandPriorityStrategy,
    candidateInfo,
    replyPolicy,
    industryVoiceId,
    resolvedTurnIndex,
    effectiveDisclosureMode,
    contextNeeds,
  );

  progress.update("校验候选人资格...");
  const candidateAge = resolveCandidateAge(turnPlan, candidateInfo);
  const regionName = resolveRegionName(turnPlan, candidateInfo);
  const ageEligibilityCity =
    turnPlan.extractedInfo.city ?? resolvePrimaryCity(configData, resolvedBrand);
  const ageEligibility = await evaluateAgeEligibility({
    ...(candidateAge !== undefined ? { age: candidateAge } : {}),
    brandAlias: resolvedBrand,
    ...(typeof ageEligibilityCity === "string" ? { cityName: ageEligibilityCity } : {}),
    ...(regionName !== undefined ? { regionName } : {}),
    ...(replyPolicy?.qualificationPolicy?.age !== undefined
      ? { strategy: replyPolicy.qualificationPolicy.age }
      : {}),
  });

  const registry = getDynamicRegistry(providerConfigs);
  const replyModel = (modelConfig?.replyModel || DEFAULT_MODEL_CONFIG.replyModel) as ModelId;
  const model = registry.languageModel(replyModel);

  const prompts = buildPolicyPrompt(
    replyPolicy,
    turnPlan,
    contextNeeds,
    contextInfo,
    candidateMessage,
    conversationHistory,
    resolvedTurnIndex,
    effectiveDisclosureMode,
    knownCandidate,
    industryVoiceId,
    defaultWechatId,
    ageEligibility,
  );

  progress.update("生成回复...");
  const replyResult = await safeGenerateText({
    model,
    system: prompts.system,
    prompt: prompts.prompt,
    context: "SmartReply",
    timeoutMs: 30_000,
    maxOutputTokens: 2000,
  });

  if (!replyResult.success) {
    progress.fail("回复生成失败");
    logError("SmartReply 生成失败", replyResult.error);
    return {
      turnPlan,
      suggestedReply: "",
      confidence: 0,
      shouldExchangeWechat: shouldExchangeWechatByStage(turnPlan.stage),
      factGateRewritten: false,
      replyGateRewritten: false,
      gateViolations: [],
      contextInfo,
      debugInfo: {
        ...debugInfo,
        resolvedBrand,
        turnIndex: resolvedTurnIndex,
        effectiveDisclosureMode,
        primaryNeed: turnPlan.primaryNeed,
        replyGateRewritten: false,
        gateViolations: [],
        gateStatus: ageEligibility.status,
        appliedStrategy: ageEligibility.appliedStrategy,
        ageRangeSummary: ageEligibility.summary,
      },
      usage: undefined,
      error: replyResult.error,
    };
  }

  let finalText = replyResult.text;
  let finalUsage = replyResult.usage;
  let finalLatencyMs = replyResult.latencyMs;
  let factGateRewritten = false;
  let replyGateRewritten = false;
  let gateViolations: ReplyGateViolationCode[] = [];

  progress.update("检查回复质量...");
  if (replyPolicy?.factGate.mode === "strict") {
    const violation = hasUnsupportedFactClaims(finalText, contextInfo, contextNeeds);
    if (violation) {
      factGateRewritten = true;
      const rewritten = await rewriteForFactGate(finalText, model, contextInfo);
      finalText = rewritten.text;
      if (rewritten.usage) finalUsage = rewritten.usage;
      if (rewritten.latencyMs !== undefined) {
        finalLatencyMs = (finalLatencyMs ?? 0) + rewritten.latencyMs;
      }
    }
  }

  const gateValidation = validateReply({
    text: finalText,
    turnIndex: resolvedTurnIndex,
    mode: effectiveDisclosureMode,
    primaryNeed: turnPlan.primaryNeed,
    allowedNeeds: contextNeeds,
    policy: replyPolicy,
  });
  gateViolations = gateValidation.violations;
  if (gateViolations.length > 0) {
    progress.update("优化回复...");
    replyGateRewritten = true;
    const rewritten = await rewriteForReplyGate(finalText, model, contextInfo, {
      turnIndex: resolvedTurnIndex,
      effectiveDisclosureMode,
      primaryNeed: turnPlan.primaryNeed,
      allowedNeeds: contextNeeds,
      violations: gateViolations,
      policy: replyPolicy,
    });
    finalText = rewritten.text;
    if (rewritten.usage) finalUsage = rewritten.usage;
    if (rewritten.latencyMs !== undefined) {
      finalLatencyMs = (finalLatencyMs ?? 0) + rewritten.latencyMs;
    }
    gateViolations = validateReply({
      text: finalText,
      turnIndex: resolvedTurnIndex,
      mode: effectiveDisclosureMode,
      primaryNeed: turnPlan.primaryNeed,
      allowedNeeds: contextNeeds,
      policy: replyPolicy,
    }).violations;
  }

  const totalLatency = finalLatencyMs ?? 0;
  const totalTokens = finalUsage?.totalTokens ?? 0;
  progress.succeed(
    `回复已生成 | ${turnPlan.stage} | ${totalLatency}ms | ${totalTokens} tokens${replyGateRewritten ? " | 已优化" : ""}`,
  );

  return {
    turnPlan,
    suggestedReply: finalText,
    confidence: Math.max(0, Math.min(1, turnPlan.confidence)),
    shouldExchangeWechat: shouldExchangeWechatByStage(turnPlan.stage),
    factGateRewritten,
    replyGateRewritten,
    gateViolations,
    contextInfo: `${contextInfo}\n当前品牌：${resolvedBrand}`,
    debugInfo: {
      ...debugInfo,
      resolvedBrand,
      turnIndex: resolvedTurnIndex,
      effectiveDisclosureMode,
      primaryNeed: turnPlan.primaryNeed,
      replyGateRewritten,
      gateViolations,
      gateStatus: ageEligibility.status,
      appliedStrategy: ageEligibility.appliedStrategy,
      ageRangeSummary: ageEligibility.summary,
    },
    usage: finalUsage,
    latencyMs: finalLatencyMs,
  };
}
