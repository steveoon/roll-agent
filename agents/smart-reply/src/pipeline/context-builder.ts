import type { ZhipinData, Store, SalaryDetails, CandidateInfo } from "../types/zhipin.ts";
import {
  findBrandByName,
  getAvailableBrandNames,
  resolveDefaultBrandName,
} from "../services/brand-config-selectors.ts";
import type { BrandPriorityStrategy } from "../types/config.ts";
import type { BrandResolutionInput, BrandResolutionOutput } from "../types/brand-resolution.ts";
import type { StoreWithDistance } from "../types/geocoding.ts";
import type {
  TurnPlan,
  TurnExtractedInfo,
  ReplyNeed,
  ReplyPolicyConfig,
  EffectiveDisclosureMode,
  ReplyFactFamily,
} from "../types/reply-policy.ts";
import { PRIMARY_NEED_FACT_MAP } from "../types/reply-policy.ts";
import { verboseLog } from "../log-control.ts";
import { getSharedBrandAliasMap } from "../services/brand-alias.ts";

// ========== Helpers ==========

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
  detailLevel: EffectiveDisclosureMode;
  primaryNeed: ReplyNeed;
  turnPlan: TurnPlan;
  aliasLookupError?: string | undefined;
}

export type { PolicyContextDebugInfo };

function buildSalaryDescription(salary: SalaryDetails): string {
  const { base, unit, range, memo } = salary;
  const normalizedMemo = memo?.replace(/\n/g, " ").trim() ?? "";

  if (base == null) {
    if (salary.scenarioSummary && normalizedMemo) {
      return `${normalizedMemo}（${salary.scenarioSummary}）`;
    }
    if (salary.scenarioSummary) return salary.scenarioSummary;
    return normalizedMemo;
  }

  const isPossiblyPieceRate = base < 10;
  let description = "";
  if (isPossiblyPieceRate && memo) {
    description = `${base}${unit ?? ""}（${normalizedMemo}）`;
  } else {
    description = `${base}${unit ?? ""}`;
    if (range && range !== `${base}-${base}` && range !== `${base}元-${base}元`) {
      description += `，范围${range}`;
    }
    if (normalizedMemo && normalizedMemo.length < 50) description += `（${normalizedMemo}）`;
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
  extractedInfo: TurnExtractedInfo,
): StoreWithDistance[] {
  const { mentionedLocations, mentionedDistricts } = extractedInfo;
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
          (store.subarea ?? "").includes(loc.location),
      );
      if (matchingLocation) locationMatch = matchingLocation.confidence * 40;
    }
    if (mentionedDistricts && mentionedDistricts.length > 0) {
      const matchingDistrict = mentionedDistricts.find(
        (dist) =>
          (store.district ?? "").includes(dist.district) ||
          (store.subarea ?? "").includes(dist.district),
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

function allowsFactInjection(primaryNeed: ReplyNeed): boolean {
  return PRIMARY_NEED_FACT_MAP[primaryNeed].length > 0;
}

function hasFactFamily(
  allowedFactFamilies: Set<ReplyFactFamily>,
  family: ReplyFactFamily,
): boolean {
  return allowedFactFamilies.has(family);
}

function shouldUseMinimalContext(
  turnIndex: number,
  disclosureMode: EffectiveDisclosureMode,
  stage: TurnPlan["stage"],
): boolean {
  if (disclosureMode === "minimal") return true;
  return turnIndex === 1 || stage === "trust_building" || stage === "private_channel";
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
  turnIndex = 1,
  disclosureMode: EffectiveDisclosureMode = "minimal",
  factNeeds: ReplyNeed[] = [turnPlan.primaryNeed],
): Promise<{
  contextInfo: string;
  resolvedBrand: string;
  debugInfo: PolicyContextDebugInfo;
}> {
  const extractedInfo = turnPlan.extractedInfo;
  const primaryNeed = turnPlan.primaryNeed;
  const effectiveFactNeeds =
    factNeeds.length > 0
      ? Array.from(new Set(factNeeds.filter((need) => need !== "none")))
      : primaryNeed === "none"
        ? []
        : [primaryNeed];
  const allowedFactFamilies = new Set<ReplyFactFamily>(
    effectiveFactNeeds.flatMap((need) => PRIMARY_NEED_FACT_MAP[need]),
  );
  const useMinimalContext = shouldUseMinimalContext(turnIndex, disclosureMode, turnPlan.stage);
  const requiresFacts = !useMinimalContext && allowsFactInjection(primaryNeed);

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
    verboseLog(`[buildContextInfoByNeeds] 品牌别名服务不可用，回退 fuzzy 解析: ${errorMessage}`);
  }

  const brandResolution = resolveBrandConflict({
    uiSelectedBrand,
    configDefaultBrand: resolveDefaultBrandName(data),
    conversationBrand: toolBrand || undefined,
    availableBrands: getAvailableBrandNames(data),
    strategy: brandPriorityStrategy || "smart",
    aliasMap,
  });

  const targetBrand = brandResolution.resolvedBrand;
  verboseLog(
    `[品牌解析] 工具传参: ${toolBrand ?? "(未指定)"} → 结果: ${targetBrand} (${brandResolution.matchType}, ${brandResolution.source})`,
  );

  const targetBrandData = findBrandByName(data, targetBrand);
  const brandStores = targetBrandData?.stores ?? [];
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
            (s.district ?? "").includes(location) ||
            (s.subarea ?? "").includes(location),
        );
        if (filtered.length > 0) relevantStores = filtered;
      }
    }

    const districts = extractedInfo.mentionedDistricts || [];
    if (districts.length > 0) {
      const filtered = relevantStores.filter((s) =>
        districts.some(
          (d) => (s.district ?? "").includes(d.district) || (s.subarea ?? "").includes(d.district),
        ),
      );
      if (filtered.length > 0) relevantStores = filtered;
    }

    if (
      relevantStores.length === brandStores.length &&
      candidateInfo?.jobAddress &&
      hasFactFamily(allowedFactFamilies, "location")
    ) {
      const filtered = relevantStores.filter(
        (s) =>
          s.name.includes(candidateInfo.jobAddress || "") ||
          s.location.includes(candidateInfo.jobAddress || "") ||
          (s.district ?? "").includes(candidateInfo.jobAddress || "") ||
          (s.subarea ?? "").includes(candidateInfo.jobAddress || ""),
      );
      if (filtered.length > 0) relevantStores = filtered;
    }
  }

  let rankedStoresWithDistance: StoreWithDistance[] = [];
  if (relevantStores.length > 0) {
    rankedStoresWithDistance = rankStoresByTextMatch(relevantStores, extractedInfo);
  }

  const storeCount = requiresFacts ? Math.min(1, rankedStoresWithDistance.length) : 0;
  const detailLevel: EffectiveDisclosureMode = requiresFacts ? "focused" : "minimal";

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
    context += `主回答轴：${primaryNeed}\n`;
    if (voice) context += `行业指纹：${voice.name} | 风格：${voice.styleKeywords.join("、")}\n`;
    context += `红线：${replyPolicy.hardConstraints.rules.map((r) => r.rule).join("；")}\n`;
  }

  if (!requiresFacts) {
    if (useMinimalContext) {
      context += "当前处于首轮或浅层沟通，优先泛化回答，不主动展开具体门店、数字或筛选条件。\n";
    } else {
      context += "本轮以推进沟通为主，无需展开岗位细节，请保持回答聚焦且克制。\n";
    }
  } else if (storeCount === 0) {
    context += "暂无可用的门店事实信息，请使用泛化回答，避免任何具体承诺。\n";
  } else {
    context += "匹配到的门店信息：\n";
    rankedStoresWithDistance.slice(0, storeCount).forEach(({ store }) => {
      const includeLocationFacts = hasFactFamily(allowedFactFamilies, "location");
      const includePositionFacts = Array.from(allowedFactFamilies).some(
        (family) => family !== "location",
      );
      const storeArea = [store.district, store.subarea]
        .filter((part): part is string => Boolean(part))
        .join("");
      context += includeLocationFacts
        ? storeArea
          ? `• ${store.name}（${storeArea}）：${store.location}\n`
          : `• ${store.name}：${store.location}\n`
        : `• ${store.name}\n`;
      if (!includePositionFacts) {
        return;
      }

      store.positions.slice(0, 3).forEach((position) => {
        context += `  职位：${position.name}\n`;
        if (hasFactFamily(allowedFactFamilies, "salary")) {
          const salaryDescription = buildSalaryDescription(position.salary);
          if (salaryDescription) context += `  薪资：${salaryDescription}\n`;
        }
        if (hasFactFamily(allowedFactFamilies, "schedule")) {
          if (position.laborForm) {
            const formParts = [position.laborForm];
            if (position.employmentForm && position.employmentForm !== "长期用工") {
              formParts.push(position.employmentForm);
            }
            context += `  用工形式：${formParts.join("，")}\n`;
          }
          if (position.timeSlots.length > 0) {
            context += `  时间：${position.timeSlots.slice(0, 3).join("、")}\n`;
          }
          if (position.minHoursPerWeek || position.maxHoursPerWeek) {
            context += `  每周工时：${position.minHoursPerWeek || 0}-${position.maxHoursPerWeek || "不限"}小时\n`;
          }
          if (position.perMonthMinWorkTime != null) {
            const monthWorkTimeUnit =
              position.perMonthMinWorkTimeUnit != null
                ? String(position.perMonthMinWorkTimeUnit)
                : "";
            context += `  月最低工时：${position.perMonthMinWorkTime}${monthWorkTimeUnit}\n`;
          }
        }
        if (hasFactFamily(allowedFactFamilies, "policy")) {
          if (position.attendanceRequirement?.description) {
            context += `  出勤要求：${position.attendanceRequirement.description}\n`;
          }
          if (position.trainingRequired && position.trainingRequired !== "不需要") {
            context += `  培训要求：${position.trainingRequired}\n`;
          }
          if (position.probationRequired && position.probationRequired !== "不需要") {
            context += `  试岗要求：${position.probationRequired}\n`;
          }
        }
        if (hasFactFamily(allowedFactFamilies, "availability")) {
          const slots = position.availableSlots?.filter((s) => s.isAvailable).slice(0, 3) || [];
          if (slots.length > 0) context += `  可用时段：${slots.map((s) => s.slot).join("、")}\n`;
        }
        if (hasFactFamily(allowedFactFamilies, "requirements")) {
          if (position.hiringRequirements) {
            const hr = position.hiringRequirements;
            const parts: string[] = [];
            if (hr.minAge != null || hr.maxAge != null) {
              parts.push(`年龄${hr.minAge ?? "不限"}-${hr.maxAge ?? "不限"}岁`);
            }
            if (hr.genderRequirement && hr.genderRequirement !== "0") {
              parts.push(`性别:${hr.genderRequirement}`);
            }
            if (hr.education && hr.education !== "不限") parts.push(`学历:${hr.education}`);
            if (hr.healthCertificate) parts.push(hr.healthCertificate);
            if (hr.languages) parts.push(`语言:${hr.languages}`);
            if (hr.socialIdentity && hr.socialIdentity !== "不限") {
              parts.push(`社会身份:${hr.socialIdentity}`);
            }
            if (parts.length > 0) context += `  要求：${parts.join("、")}\n`;
            if (hr.recruitmentRemark) {
              context += `  招聘备注：${hr.recruitmentRemark.slice(0, 200)}\n`;
            }
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
      primaryNeed,
      turnPlan,
      aliasLookupError,
    },
  };
}
