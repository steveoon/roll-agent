import { z } from "zod";
import {
  getDynamicRegistry,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_PROVIDER_CONFIGS,
} from "../ai/model-registry.ts";
import type { ModelId } from "../ai/model-registry.ts";
import { safeGenerateObject } from "../ai/structured-output.ts";
import {
  FunnelStageSchema,
  ChannelTypeSchema,
  TurnPlanSchema,
  STAGE_DEFINITIONS,
} from "../types/reply-policy.ts";
import type {
  TurnPlan,
  ReplyNeed,
  FunnelStage,
  ChannelType,
  ReplyPolicyConfig,
} from "../types/reply-policy.ts";
import { BrandDataSchema } from "../types/classification.ts";
import type { ProviderConfigs, ClassificationOptions } from "../types/classification.ts";

function normalizeChannelType(channelType: unknown): ChannelType {
  const parsed = ChannelTypeSchema.safeParse(channelType);
  return parsed.success ? parsed.data : "public";
}

function getActiveStages(channelType: unknown = "public"): FunnelStage[] {
  const normalizedChannelType = normalizeChannelType(channelType);
  const activeStages = FunnelStageSchema.options.filter((stage) =>
    STAGE_DEFINITIONS[stage].applicableChannels.includes(normalizedChannelType),
  );
  return activeStages.length > 0 ? activeStages : [...FunnelStageSchema.options];
}

function buildDynamicPlanningSchema(
  activeStages: FunnelStage[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  return z.object({
    stage: z.enum(activeStages as [FunnelStage, ...FunnelStage[]]),
    subGoals: TurnPlanSchema.shape.subGoals,
    needs: TurnPlanSchema.shape.needs,
    riskFlags: TurnPlanSchema.shape.riskFlags,
    confidence: TurnPlanSchema.shape.confidence,
    extractedInfo: TurnPlanSchema.shape.extractedInfo,
    reasoningText: TurnPlanSchema.shape.reasoningText,
  });
}

const NEED_RULES: Array<{ need: ReplyNeed; patterns: RegExp[] }> = [
  { need: "salary", patterns: [/薪资|工资|时薪|底薪|提成|奖金|补贴|多少钱|收入/i] },
  { need: "schedule", patterns: [/排班|班次|几点|上班|下班|工时|周末|节假日|做几天/i] },
  { need: "policy", patterns: [/五险一金|社保|保险|合同|考勤|迟到|补班|试用期/i] },
  { need: "availability", patterns: [/还有名额|空位|可用时段|什么时候能上|明天能面/i] },
  { need: "location", patterns: [/在哪|位置|地址|附近|地铁|门店|哪个区|多远/i] },
  { need: "stores", patterns: [/门店|哪家店|哪些店|有店吗/i] },
  { need: "requirements", patterns: [/要求|条件|年龄|经验|学历|健康证|身高|体重/i] },
  { need: "interview", patterns: [/面试|到店|约时间|约面/i] },
  { need: "wechat", patterns: [/微信|vx|私聊|联系方式|加你/i] },
];

function detectRuleNeeds(message: string, history: string[]): Set<ReplyNeed> {
  const text = `${history.slice(-4).join(" ")} ${message}`;
  const needs = new Set<ReplyNeed>();
  for (const rule of NEED_RULES) {
    if (rule.patterns.some((p) => p.test(text))) needs.add(rule.need);
  }
  if (needs.size === 0) needs.add("none");
  else needs.delete("none");
  return needs;
}

function sanitizePlan(plan: TurnPlan, ruleNeeds: Set<ReplyNeed>): TurnPlan {
  const mergedNeeds = new Set<ReplyNeed>([...plan.needs, ...Array.from(ruleNeeds)]);
  if (mergedNeeds.size > 1 && mergedNeeds.has("none")) mergedNeeds.delete("none");
  return {
    ...plan,
    needs: Array.from(mergedNeeds),
    confidence: Number.isFinite(plan.confidence) ? Math.max(0, Math.min(1, plan.confidence)) : 0.5,
  };
}

function buildPlanningPrompt(
  message: string,
  history: string[],
  brandData?: z.infer<typeof BrandDataSchema>,
  channelType: ChannelType = "public",
  replyPolicy?: Pick<ReplyPolicyConfig, "stageGoals">,
): { system: string; prompt: string } {
  const system = [
    "你是招聘对话回合规划器，不直接回复候选人。",
    "你只输出结构化规划结果，用于后续回复生成。",
    "规划目标：确定阶段目标(stage)、子目标(subGoals)、事实需求(needs)、风险标记(riskFlags)。",
  ].join("\n");

  const normalizedChannelType = normalizeChannelType(channelType);
  const activeStages = getActiveStages(normalizedChannelType);
  const stageLines = activeStages.map((stage) => {
    const def = STAGE_DEFINITIONS[stage];
    const desc = replyPolicy?.stageGoals[stage]?.description || def.description;
    return `- ${stage}: ${desc} (转入条件: ${def.transitionSignal})`;
  });

  const needsLine =
    normalizedChannelType === "private"
      ? "- stores, location, salary, schedule, policy, availability, requirements, interview, none"
      : "- stores, location, salary, schedule, policy, availability, requirements, interview, wechat, none";

  const prompt = [
    "[阶段枚举与定义]",
    ...stageLines,
    "",
    "[needs枚举]",
    needsLine,
    "",
    "[riskFlags枚举]",
    "- insurance_promise_risk, age_sensitive, confrontation_emotion, urgency_high, qualification_mismatch",
    "",
    "[规则]",
    "- 优先判断本轮主阶段(stage)；subGoals 可多项。",
    "- 候选人追问事实时，必须打开对应 needs。",
    "- 不确定时 confidence 降低，不要臆断。",
    "- 根据转入条件判断阶段转化，不要停留在不匹配的阶段。",
    "",
    "[品牌数据]",
    JSON.stringify(brandData || {}),
    "",
    "[历史对话]",
    history.slice(-8).join("\n") || "无",
    "",
    "[候选人消息]",
    message,
  ].join("\n");

  return { system, prompt };
}

export async function planTurn(
  message: string,
  options: Omit<ClassificationOptions, "candidateMessage"> & {
    providerConfigs?: ProviderConfigs;
    replyPolicy?: Pick<ReplyPolicyConfig, "stageGoals">;
  },
): Promise<TurnPlan> {
  const {
    providerConfigs = DEFAULT_PROVIDER_CONFIGS,
    modelConfig,
    conversationHistory = [],
    brandData,
    channelType,
    replyPolicy,
  } = options;

  const registry = getDynamicRegistry(providerConfigs);
  const classifyModel = (modelConfig?.classifyModel ||
    DEFAULT_MODEL_CONFIG.classifyModel) as ModelId;

  const normalizedChannelType = normalizeChannelType(channelType);
  const activeStages = getActiveStages(normalizedChannelType);
  const dynamicSchema = buildDynamicPlanningSchema(activeStages);
  const prompts = buildPlanningPrompt(
    message,
    conversationHistory,
    brandData,
    normalizedChannelType,
    replyPolicy,
  );

  const result = await safeGenerateObject({
    model: registry.languageModel(classifyModel),
    schema: dynamicSchema,
    schemaName: "TurnPlanningOutput",
    system: prompts.system,
    prompt: prompts.prompt,
  });

  const ruleNeeds = detectRuleNeeds(message, conversationHistory);

  if (!result.success) {
    return {
      stage: "trust_building",
      subGoals: ["保持对话并澄清需求"],
      needs: Array.from(ruleNeeds),
      riskFlags: [],
      confidence: 0.35,
      extractedInfo: {
        mentionedBrand: null,
        city: brandData?.city || null,
        mentionedLocations: null,
        mentionedDistricts: null,
        specificAge: null,
        hasUrgency: null,
        preferredSchedule: null,
      },
      reasoningText: "规划模型失败，使用规则降级策略",
    };
  }

  return sanitizePlan(result.data as TurnPlan, ruleNeeds);
}
