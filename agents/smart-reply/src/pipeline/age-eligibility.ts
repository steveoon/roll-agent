import {
  fetchJobListPage,
  getDulidayToken,
  getDulidayJobListEndpoint,
  extractResults,
  buildCityCandidates,
  buildBrandCandidates,
} from "../services/duliday-api.ts";

export type AgeEligibilityStatus = "pass" | "fail" | "unknown";

export type AgeEligibilitySummary = {
  minAgeObserved: number | null;
  maxAgeObserved: number | null;
  matchedCount: number;
  total: number;
};

export type AgeQualificationPolicy = {
  enabled: boolean;
  revealRange: boolean;
  failStrategy: string;
  unknownStrategy: string;
  passStrategy: string;
  allowRedirect: boolean;
  redirectPriority: "low" | "medium" | "high";
};

export type AgeEligibilityAppliedStrategy = AgeQualificationPolicy & {
  status: AgeEligibilityStatus;
  strategy: string;
};

export type AgeEligibilityResult = {
  status: AgeEligibilityStatus;
  summary: AgeEligibilitySummary;
  appliedStrategy: AgeEligibilityAppliedStrategy;
};

const fallbackPolicy: AgeQualificationPolicy = {
  enabled: false,
  revealRange: false,
  failStrategy: "礼貌说明不匹配，避免承诺",
  unknownStrategy: "先核实年龄或资格条件",
  passStrategy: "确认匹配后推进下一步",
  allowRedirect: false,
  redirectPriority: "low",
};

const JOB_LIST_PAGE_SIZE = 200;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string");
    return typeof first === "string" ? first : "";
  }
  return "";
}

function pickText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (key in source) {
      const text = firstText(source[key]);
      if (text) return text;
    }
  }
  return "";
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function buildAppliedStrategy(
  status: AgeEligibilityStatus,
  policy?: AgeQualificationPolicy,
): AgeEligibilityAppliedStrategy {
  const effective = policy ?? fallbackPolicy;
  const strategy =
    status === "pass"
      ? effective.passStrategy
      : status === "fail"
        ? effective.failStrategy
        : effective.unknownStrategy;
  return { ...effective, status, strategy };
}

export async function evaluateAgeEligibility({
  age,
  brandAlias,
  cityName,
  regionName,
  strategy,
}: {
  age?: number | null;
  brandAlias?: string | null;
  cityName?: string | null;
  regionName?: string | null;
  strategy?: AgeQualificationPolicy;
}): Promise<AgeEligibilityResult> {
  const token = getDulidayToken();
  const endpoint = getDulidayJobListEndpoint();
  const summary: AgeEligibilitySummary = {
    minAgeObserved: null,
    maxAgeObserved: null,
    matchedCount: 0,
    total: 0,
  };

  if (!token) {
    return {
      status: "unknown",
      summary,
      appliedStrategy: buildAppliedStrategy("unknown", strategy),
    };
  }
  if (!endpoint) {
    return {
      status: "unknown",
      summary,
      appliedStrategy: buildAppliedStrategy("unknown", strategy),
    };
  }

  try {
    const payload = await fetchJobListPage(token, endpoint, 1, JOB_LIST_PAGE_SIZE, {
      brandAlias: brandAlias ?? null,
      cityName: cityName ?? null,
    });
    const { items, total } = extractResults(payload);
    summary.total = total;
    const hasAdditionalPages = total > items.length && items.length >= JOB_LIST_PAGE_SIZE;

    const brandFilters = buildBrandCandidates(brandAlias, cityName)
      .map((c) => normalizeText(c))
      .filter(Boolean);
    const cityFilters = buildCityCandidates(cityName)
      .map((c) => normalizeText(c))
      .filter(Boolean);
    const regionFilter = normalizeText(regionName);

    let anyRange = false;
    let anyMatch = false;

    for (const item of items) {
      if (!isRecord(item)) continue;
      const record = item;
      const basicInfo = isRecord(record.basicInfo)
        ? (record.basicInfo as Record<string, unknown>)
        : null;
      const storeInfo =
        basicInfo && isRecord(basicInfo.storeInfo)
          ? (basicInfo.storeInfo as Record<string, unknown>)
          : null;

      const itemBrand = normalizeText(
        pickText(record, ["brandAlias", "brandName", "brand", "organizationName"]) ||
          (basicInfo ? pickText(basicInfo, ["brandAlias", "brandName", "brand"]) : ""),
      );
      const itemCity = normalizeText(
        pickText(record, ["cityName", "storeCityName", "jobCityName"]) ||
          (storeInfo ? pickText(storeInfo, ["storeCityName", "cityName"]) : ""),
      );
      const itemRegion = normalizeText(
        pickText(record, ["regionName", "storeRegionName", "districtName"]) ||
          (storeInfo ? pickText(storeInfo, ["storeRegionName", "regionName", "districtName"]) : ""),
      );
      const itemAddress = normalizeText(
        pickText(record, ["storeAddress", "jobAddress", "address", "storeExactAddress"]) ||
          (storeInfo ? pickText(storeInfo, ["storeAddress", "storeExactAddress", "address"]) : ""),
      );

      if (
        brandFilters.length > 0 &&
        !brandFilters.some((f) => itemBrand.includes(f) || f.includes(itemBrand))
      ) {
        continue;
      }
      if (cityFilters.length > 0 && !cityFilters.some((f) => itemCity.includes(f))) continue;
      if (
        regionFilter &&
        !itemRegion.includes(regionFilter) &&
        !itemAddress.includes(regionFilter)
      ) {
        continue;
      }

      summary.matchedCount += 1;

      const hiringRequirement = isRecord(record.hiringRequirement)
        ? record.hiringRequirement
        : undefined;
      const requirement = isRecord(hiringRequirement?.basicPersonalRequirements)
        ? hiringRequirement.basicPersonalRequirements
        : undefined;

      const minAge = toNumber(requirement?.minAge ?? record.minAge);
      const maxAge = toNumber(requirement?.maxAge ?? record.maxAge);

      if (minAge !== null) {
        anyRange = true;
        summary.minAgeObserved =
          summary.minAgeObserved === null ? minAge : Math.min(summary.minAgeObserved, minAge);
      }
      if (maxAge !== null) {
        anyRange = true;
        summary.maxAgeObserved =
          summary.maxAgeObserved === null ? maxAge : Math.max(summary.maxAgeObserved, maxAge);
      }

      if (typeof age === "number") {
        const belowMin = minAge !== null && age < minAge;
        const aboveMax = maxAge !== null && age > maxAge;
        if (!belowMin && !aboveMax) anyMatch = true;
      }
    }

    if (typeof age !== "number" || summary.matchedCount === 0 || !anyRange) {
      return {
        status: "unknown",
        summary,
        appliedStrategy: buildAppliedStrategy("unknown", strategy),
      };
    }

    if (hasAdditionalPages) {
      return {
        status: "unknown",
        summary,
        appliedStrategy: buildAppliedStrategy("unknown", strategy),
      };
    }

    const status: AgeEligibilityStatus = anyMatch ? "pass" : "fail";
    return { status, summary, appliedStrategy: buildAppliedStrategy(status, strategy) };
  } catch {
    return {
      status: "unknown",
      summary,
      appliedStrategy: buildAppliedStrategy("unknown", strategy),
    };
  }
}
