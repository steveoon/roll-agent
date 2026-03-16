import type {
  ZhipinData,
  Store,
  MessageClassification,
  SalaryDetails,
  CandidateInfo,
} from "../types/zhipin.ts";
import type { BrandPriorityStrategy } from "../types/config.ts";
import type { BrandResolutionInput, BrandResolutionOutput } from "../types/brand-resolution.ts";
import type { StoreWithDistance } from "../types/geocoding.ts";
import type { TurnPlan, ReplyNeed, ReplyPolicyConfig } from "../types/reply-policy.ts";
import { getSharedBrandAliasMap } from "../services/brand-alias.ts";

// ========== Helpers ==========

type DetailLevel = "minimal" | "focused";

interface StoreScore {
  store: Store;
  score: number;
  breakdown: {
    locationMatch: number;
    districtMatch: number;
    positionDiversity: number;
    availability: number;
  };
}

interface PolicyContextDebugInfo {
  relevantStores: StoreWithDistance[];
  storeCount: number;
  detailLevel: DetailLevel;
  turnPlan: TurnPlan;
  aliasLookupError?: string | undefined;
}

export type { PolicyContextDebugInfo };

function buildSalaryDescription(salary: SalaryDetails): string {
  const { base, range, memo } = salary;
  const isPossiblyPieceRate = base < 10;
  let description = "";
  if (isPossiblyPieceRate && memo) {
    description = `${base}元（${memo.replace(/\n/g, " ").trim()}）`;
  } else {
    description = `${base}元/时`;
    if (range && range !== `${base}-${base}`) description += `，范围${range}元`;
    if (memo && memo.length < 50) description += `（${memo.replace(/\n/g, " ").trim()}）`;
  }
  if (salary.scenarioSummary) description += `（${salary.scenarioSummary}）`;
  return description;
}

export function fuzzyMatchBrand(
  inputBrand: string,
  availableBrands: string[],
  aliasMap?: Map<string, string>,
): string | null {
  if (!inputBrand) return null;
  const normalizeBrandName = (value: string) => value.toLowerCase().replace(/[\s._-]+/g, "");

  if (aliasMap) {
    const aliasResult =
      aliasMap.get(normalizeBrandName(inputBrand)) || aliasMap.get(inputBrand.toLowerCase());
    if (aliasResult && availableBrands.includes(aliasResult)) return aliasResult;
  }

  const inputLower = inputBrand.toLowerCase();
  const inputNormalized = normalizeBrandName(inputBrand);

  const exactMatch = availableBrands.find((b) => b.toLowerCase() === inputLower);
  if (exactMatch) return exactMatch;

  const normalizedMatch = availableBrands.find((b) => normalizeBrandName(b) === inputNormalized);
  if (normalizedMatch) return normalizedMatch;

  const containsMatches = availableBrands.filter((brand) => {
    const brandLower = brand.toLowerCase();
    if (brandLower.includes(inputLower) || inputLower.includes(brandLower)) return true;
    const brandNormalized = normalizeBrandName(brand);
    return brandNormalized.includes(inputNormalized) || inputNormalized.includes(brandNormalized);
  });

  if (containsMatches.length > 0) {
    return containsMatches.sort((a, b) => b.length - a.length)[0] ?? null;
  }

  if (inputLower.includes("山姆") || inputLower.includes("sam")) {
    const samBrand = availableBrands.find((b) => {
      const bl = b.toLowerCase();
      return bl.includes("山姆") || bl.includes("sam");
    });
    if (samBrand) return samBrand;
  }

  return null;
}

export function resolveBrandConflict(input: BrandResolutionInput): BrandResolutionOutput {
  const {
    uiSelectedBrand,
    configDefaultBrand,
    conversationBrand,
    availableBrands,
    strategy = "smart",
    aliasMap,
  } = input;

  const tryMatchBrand = (brand: string | undefined, _source: string): string | undefined => {
    if (!brand) return undefined;
    return fuzzyMatchBrand(brand, availableBrands, aliasMap) ?? undefined;
  };

  switch (strategy) {
    case "user-selected": {
      const uiMatched = tryMatchBrand(uiSelectedBrand, "UI选择");
      if (uiMatched) {
        return {
          resolvedBrand: uiMatched,
          matchType: uiMatched === uiSelectedBrand ? "exact" : "fuzzy",
          source: "ui",
          reason: `用户选择策略`,
          originalInput: uiSelectedBrand,
        };
      }
      const configMatched = tryMatchBrand(configDefaultBrand, "配置默认");
      if (configMatched) {
        return {
          resolvedBrand: configMatched,
          matchType: configMatched === configDefaultBrand ? "exact" : "fuzzy",
          source: "config",
          reason: `配置默认`,
          originalInput: configDefaultBrand,
        };
      }
      return {
        resolvedBrand: availableBrands[0] ?? "",
        matchType: "fallback",
        source: "default",
        reason: `系统默认`,
      };
    }
    case "conversation-extracted": {
      const conversationMatched = tryMatchBrand(conversationBrand, "对话提取");
      if (conversationMatched) {
        return {
          resolvedBrand: conversationMatched,
          matchType: conversationMatched === conversationBrand ? "exact" : "fuzzy",
          source: "conversation",
          reason: `对话提取`,
          originalInput: conversationBrand,
        };
      }
      const uiMatched = tryMatchBrand(uiSelectedBrand, "UI选择");
      if (uiMatched) {
        return {
          resolvedBrand: uiMatched,
          matchType: uiMatched === uiSelectedBrand ? "exact" : "fuzzy",
          source: "ui",
          reason: `UI选择`,
          originalInput: uiSelectedBrand,
        };
      }
      const configMatched = tryMatchBrand(configDefaultBrand, "配置默认");
      if (configMatched) {
        return {
          resolvedBrand: configMatched,
          matchType: configMatched === configDefaultBrand ? "exact" : "fuzzy",
          source: "config",
          reason: `配置默认`,
          originalInput: configDefaultBrand,
        };
      }
      return {
        resolvedBrand: availableBrands[0] ?? "",
        matchType: "fallback",
        source: "default",
        reason: `系统默认`,
      };
    }
    case "smart":
    default: {
      const conversationMatched = tryMatchBrand(conversationBrand, "对话提取");
      const uiMatched = tryMatchBrand(uiSelectedBrand, "UI选择");
      if (conversationMatched) {
        return {
          resolvedBrand: conversationMatched,
          matchType: conversationMatched === conversationBrand ? "exact" : "fuzzy",
          source: "conversation",
          reason: `智能策略: 对话提取`,
          originalInput: conversationBrand,
        };
      }
      if (uiMatched) {
        return {
          resolvedBrand: uiMatched,
          matchType: uiMatched === uiSelectedBrand ? "exact" : "fuzzy",
          source: "ui",
          reason: `智能策略: UI选择`,
          originalInput: uiSelectedBrand,
        };
      }
      const configMatched = tryMatchBrand(configDefaultBrand, "配置默认");
      if (configMatched) {
        return {
          resolvedBrand: configMatched,
          matchType: configMatched === configDefaultBrand ? "exact" : "fuzzy",
          source: "config",
          reason: `智能策略: 配置默认`,
          originalInput: configDefaultBrand,
        };
      }
      return {
        resolvedBrand: availableBrands[0] ?? "",
        matchType: "fallback",
        source: "default",
        reason: `智能策略: 系统默认`,
      };
    }
  }
}

function rankStoresByTextMatch(
  stores: Store[],
  classification: MessageClassification,
): StoreWithDistance[] {
  const { mentionedLocations, mentionedDistricts } = classification.extractedInfo;
  const scoredStores: StoreScore[] = stores.map((store) => {
    let locationMatch = 0;
    let districtMatch = 0;
    let positionDiversity = 0;
    let availability = 0;

    if (mentionedLocations && mentionedLocations.length > 0) {
      const matchingLocation = mentionedLocations.find(
        (loc) =>
          store.name.includes(loc.location) ||
          store.location.includes(loc.location) ||
          store.subarea.includes(loc.location),
      );
      if (matchingLocation) locationMatch = matchingLocation.confidence * 40;
    }
    if (mentionedDistricts && mentionedDistricts.length > 0) {
      const matchingDistrict = mentionedDistricts.find(
        (dist) => store.district.includes(dist.district) || store.subarea.includes(dist.district),
      );
      if (matchingDistrict) districtMatch = matchingDistrict.confidence * 30;
    }
    const uniquePositionTypes = new Set(store.positions.map((p) => p.name));
    positionDiversity = Math.min(uniquePositionTypes.size * 5, 20);
    const availablePositions = store.positions.filter((p) =>
      p.availableSlots?.some((slot) => slot.isAvailable),
    );
    availability = Math.min(availablePositions.length * 2, 10);

    return {
      store,
      score: locationMatch + districtMatch + positionDiversity + availability,
      breakdown: { locationMatch, districtMatch, positionDiversity, availability },
    };
  });

  const ranked = scoredStores.sort((a, b) => b.score - a.score);
  return ranked.map((item) => ({ store: item.store, distance: undefined }));
}

function getScheduleTypeText(scheduleType: string): string {
  if (!scheduleType) return "灵活排班";
  const typeMap: Record<string, string> = {
    fixed: "固定排班",
    flexible: "灵活排班",
    rotating: "轮班制",
    on_call: "随叫随到",
  };
  return typeMap[scheduleType] || "灵活排班";
}

// ========== Main Export ==========

export async function buildContextInfoByNeeds(
  data: ZhipinData,
  turnPlan: TurnPlan,
  uiSelectedBrand?: string,
  toolBrand?: string,
  brandPriorityStrategy?: BrandPriorityStrategy,
  candidateInfo?: CandidateInfo,
  replyPolicy?: ReplyPolicyConfig,
  industryVoiceId?: string,
): Promise<{
  contextInfo: string;
  resolvedBrand: string;
  debugInfo: PolicyContextDebugInfo;
}> {
  const extractedInfo = turnPlan.extractedInfo;
  const needs = new Set<ReplyNeed>(turnPlan.needs || []);
  const requiresFacts =
    needs.has("stores") ||
    needs.has("location") ||
    needs.has("salary") ||
    needs.has("schedule") ||
    needs.has("policy") ||
    needs.has("availability") ||
    needs.has("requirements");

  let aliasMap: Map<string, string> | undefined;
  let aliasLookupError: string | undefined;
  try {
    aliasMap = await getSharedBrandAliasMap();
  } catch (error) {
    const errorMessage =
      typeof error === "object" &&
      error !== null &&
      "userMessage" in error &&
      typeof (error as { userMessage?: unknown }).userMessage === "string"
        ? (error as { userMessage: string }).userMessage
        : error instanceof Error
          ? error.message
          : String(error);
    aliasLookupError = errorMessage;
    console.error(`[buildContextInfoByNeeds] 品牌别名服务不可用，回退 fuzzy 解析: ${errorMessage}`);
  }

  const brandResolution = resolveBrandConflict({
    uiSelectedBrand,
    configDefaultBrand: data.defaultBrand,
    conversationBrand: toolBrand || undefined,
    availableBrands: Object.keys(data.brands),
    strategy: brandPriorityStrategy || "smart",
    aliasMap,
  });

  const targetBrand = brandResolution.resolvedBrand;
  console.error(
    `[品牌解析] 工具传参: ${toolBrand ?? "(未指定)"} → 结果: ${targetBrand} (${brandResolution.matchType}, ${brandResolution.source})`,
  );

  const brandStores = data.stores.filter((store) => store.brand === targetBrand);
  let relevantStores = brandStores;

  if (relevantStores.length > 0) {
    const locations = extractedInfo.mentionedLocations || [];
    if (locations.length > 0) {
      const location = locations[0]?.location?.trim();
      if (location) {
        const filtered = relevantStores.filter(
          (s) =>
            s.name.includes(location) ||
            s.location.includes(location) ||
            s.district.includes(location) ||
            s.subarea.includes(location),
        );
        if (filtered.length > 0) relevantStores = filtered;
      }
    }

    const districts = extractedInfo.mentionedDistricts || [];
    if (districts.length > 0) {
      const filtered = relevantStores.filter((s) =>
        districts.some((d) => s.district.includes(d.district) || s.subarea.includes(d.district)),
      );
      if (filtered.length > 0) relevantStores = filtered;
    }

    if (
      relevantStores.length === brandStores.length &&
      candidateInfo?.jobAddress &&
      (needs.has("stores") || needs.has("location"))
    ) {
      const filtered = relevantStores.filter(
        (s) =>
          s.name.includes(candidateInfo.jobAddress || "") ||
          s.location.includes(candidateInfo.jobAddress || "") ||
          s.district.includes(candidateInfo.jobAddress || "") ||
          s.subarea.includes(candidateInfo.jobAddress || ""),
      );
      if (filtered.length > 0) relevantStores = filtered;
    }
  }

  let rankedStoresWithDistance: StoreWithDistance[] = [];
  if (relevantStores.length > 0) {
    const pseudoClassification: MessageClassification = {
      replyType: "general_chat",
      extractedInfo: {
        mentionedBrand: extractedInfo.mentionedBrand ?? null,
        city: extractedInfo.city ?? null,
        mentionedLocations: extractedInfo.mentionedLocations ?? null,
        mentionedDistricts: extractedInfo.mentionedDistricts ?? null,
        specificAge: extractedInfo.specificAge ?? null,
        hasUrgency: extractedInfo.hasUrgency ?? null,
        preferredSchedule: extractedInfo.preferredSchedule ?? null,
      },
      reasoningText: turnPlan.reasoningText || "",
    };
    rankedStoresWithDistance = rankStoresByTextMatch(relevantStores, pseudoClassification);
  }

  const storeCount = Math.min(
    needs.has("stores") || needs.has("location") ? 5 : 3,
    rankedStoresWithDistance.length,
  );
  const detailLevel: DetailLevel = requiresFacts ? "focused" : "minimal";

  let context = `阶段目标：${turnPlan.stage}\n默认推荐品牌：${targetBrand}\n`;
  if (aliasLookupError) {
    context += `系统状态：品牌别名服务暂不可用，已回退为规则匹配（${aliasLookupError}）。\n`;
  }

  if (replyPolicy) {
    const stageGoal = replyPolicy.stageGoals[turnPlan.stage];
    const voiceId = industryVoiceId || replyPolicy.defaultIndustryVoiceId;
    const voice = replyPolicy.industryVoices[voiceId];
    context += `策略目标：${stageGoal.primaryGoal}\n`;
    context += `推进方式：${stageGoal.ctaStrategy}\n`;
    if (voice) context += `行业指纹：${voice.name} | 风格：${voice.styleKeywords.join("、")}\n`;
    context += `红线：${replyPolicy.hardConstraints.rules.map((r) => r.rule).join("；")}\n`;
  }

  if (!requiresFacts) {
    context += "候选人当前未深入咨询岗位细节，请优先建立信任与推进下一步。\n";
  } else if (storeCount === 0) {
    context += "暂无可用的门店事实信息，请使用泛化回答，避免任何具体承诺。\n";
  } else {
    context += "匹配到的门店信息：\n";
    rankedStoresWithDistance.slice(0, storeCount).forEach(({ store }) => {
      context += `• ${store.name}（${store.district}${store.subarea}）：${store.location}\n`;
      store.positions.forEach((position) => {
        context += `  职位：${position.name}\n`;
        if (needs.has("salary")) context += `  薪资：${buildSalaryDescription(position.salary)}\n`;
        if (needs.has("schedule")) {
          context += `  排班：${getScheduleTypeText(position.scheduleType)}\n`;
          context += `  时间：${position.timeSlots.slice(0, 3).join("、")}\n`;
          if (position.minHoursPerWeek || position.maxHoursPerWeek) {
            context += `  每周工时：${position.minHoursPerWeek || 0}-${position.maxHoursPerWeek || "不限"}小时\n`;
          }
        }
        if (needs.has("policy")) {
          context += `  考勤：最多迟到${position.attendancePolicy.lateToleranceMinutes}分钟\n`;
          if (position.attendanceRequirement?.description) {
            context += `  出勤要求：${position.attendanceRequirement.description}\n`;
          }
        }
        if (needs.has("availability")) {
          const slots = position.availableSlots?.filter((s) => s.isAvailable).slice(0, 3) || [];
          if (slots.length > 0) context += `  可用时段：${slots.map((s) => s.slot).join("、")}\n`;
        }
        if (needs.has("requirements")) {
          if (position.hiringRequirements) {
            const hr = position.hiringRequirements;
            const parts: string[] = [];
            if (hr.minAge != null || hr.maxAge != null) {
              parts.push(`年龄${hr.minAge ?? "不限"}-${hr.maxAge ?? "不限"}岁`);
            }
            if (hr.genderRequirement && hr.genderRequirement !== "0") {
              parts.push(`性别:${hr.genderRequirement}`);
            }
            if (hr.education && hr.education !== "1") parts.push(`学历:${hr.education}`);
            if (parts.length > 0) context += `  要求：${parts.join("、")}\n`;
          } else if (position.requirements?.length) {
            context += `  要求：${position.requirements.filter((r) => r !== "无").join("、")}\n`;
          }
        }
      });
    });
  }

  return {
    contextInfo: context,
    resolvedBrand: targetBrand,
    debugInfo: {
      relevantStores:
        rankedStoresWithDistance.length > 0
          ? rankedStoresWithDistance
          : relevantStores.map((s) => ({ store: s, distance: undefined })),
      storeCount,
      detailLevel,
      turnPlan,
      aliasLookupError,
    },
  };
}
