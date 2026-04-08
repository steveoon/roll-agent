import { z } from "zod";
import {
  fetchJobListPage,
  extractResults,
  buildCityCandidates,
  buildBrandCandidates,
} from "../services/duliday-api.ts";
import type { AgeQualificationPolicy } from "../types/reply-policy.ts";
import type { ZhipinData } from "../types/zhipin.ts";

export const AGE_ELIGIBILITY_STATUSES = ["pass", "fail", "unknown"] as const;
export type AgeEligibilityStatus = (typeof AGE_ELIGIBILITY_STATUSES)[number];

export const AgeEvidenceSchema = z.object({
  minAge: z.number().nullable(),
  maxAge: z.number().nullable(),
});

export type AgeEvidence = z.infer<typeof AgeEvidenceSchema>;

export const AgeEvidenceCollectionSchema = z.object({
  evidence: z.array(AgeEvidenceSchema),
  matchedCount: z.number().int().min(0),
  total: z.number().int().min(0),
  isComplete: z.boolean(),
});

export type AgeEvidenceCollection = z.infer<typeof AgeEvidenceCollectionSchema>;

export type AgeEvidenceSourceResult = AgeEvidence[] | AgeEvidenceCollection;

export type AgeEligibilityQuery = {
  brandAlias?: string | null;
  cityName?: string | null;
  regionName?: string | null;
};

export interface AgeEligibilitySource {
  name: string;
  collect(query: AgeEligibilityQuery): Promise<AgeEvidenceSourceResult>;
}

export type AgeEligibilitySummary = {
  minAgeObserved: number | null;
  maxAgeObserved: number | null;
  matchedCount: number;
  total: number;
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
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string");
    return typeof first === "string" ? first : "";
  }
  return "";
}

function pickText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const text = firstText(source[key]);
    if (text) {
      return text;
    }
  }
  return "";
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return null;
}

function normalizeFilters(values: string[]): string[] {
  return values.map((value) => normalizeText(value)).filter(Boolean);
}

function matchesTextCandidates(value: string | null | undefined, candidates: string[]): boolean {
  if (candidates.length === 0) {
    return true;
  }
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  return candidates.some((candidate) => {
    return normalized.includes(candidate) || candidate.includes(normalized);
  });
}

function matchesAnyField(
  values: Array<string | null | undefined>,
  candidates: string[],
): boolean {
  if (candidates.length === 0) {
    return true;
  }
  return values.some((value) => matchesTextCandidates(value, candidates));
}

function matchesRegion(
  values: Array<string | null | undefined>,
  regionFilter: string,
): boolean {
  if (!regionFilter) {
    return true;
  }
  return values.some((value) => normalizeText(value).includes(regionFilter));
}

function hasUsableAgeEvidence(evidence: AgeEvidence[]): boolean {
  return evidence.some((item) => item.minAge !== null || item.maxAge !== null);
}

function buildAppliedStrategy(
  status: AgeEligibilityStatus,
  policy?: AgeQualificationPolicy,
): AgeEligibilityAppliedStrategy {
  const effective = policy ?? fallbackPolicy;
  let strategy = effective.unknownStrategy;
  if (status === "pass") {
    strategy = effective.passStrategy;
  } else if (status === "fail") {
    strategy = effective.failStrategy;
  }
  return { ...effective, status, strategy };
}

function createEmptyAgeEvidenceCollection(): AgeEvidenceCollection {
  return {
    evidence: [],
    matchedCount: 0,
    total: 0,
    isComplete: true,
  };
}

function normalizeEvidenceCollection(result: AgeEvidenceSourceResult): AgeEvidenceCollection {
  if (Array.isArray(result)) {
    const evidence = result
      .map((item) => AgeEvidenceSchema.safeParse(item))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data);
    return {
      evidence,
      matchedCount: evidence.length,
      total: evidence.length,
      isComplete: true,
    };
  }

  const parsedCollection = AgeEvidenceCollectionSchema.safeParse(result);
  if (!parsedCollection.success) {
    return createEmptyAgeEvidenceCollection();
  }

  const evidence = parsedCollection.data.evidence
    .map((item) => AgeEvidenceSchema.safeParse(item))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);

  return {
    evidence,
    matchedCount: parsedCollection.data.matchedCount,
    total: parsedCollection.data.total,
    isComplete: parsedCollection.data.isComplete,
  };
}

export function createConfigDataAgeSource(configData: ZhipinData): AgeEligibilitySource {
  return {
    name: "config-data",
    async collect(query) {
      const brandFilters = normalizeFilters(
        buildBrandCandidates(query.brandAlias, query.cityName),
      );
      const cityFilters = normalizeFilters(buildCityCandidates(query.cityName));
      const regionFilter = normalizeText(query.regionName);
      const evidence: AgeEvidence[] = [];
      let total = 0;
      let matchedCount = 0;

      for (const brand of configData.brands) {
        const brandFields = [brand.name, ...(brand.aliases ?? [])];
        if (!matchesAnyField(brandFields, brandFilters)) {
          continue;
        }

        for (const store of brand.stores) {
          if (!matchesAnyField([store.city], cityFilters)) {
            continue;
          }
          total += store.positions.length;

          if (
            !matchesRegion(
              [store.district, store.subarea, store.location, store.name],
              regionFilter,
            )
          ) {
            continue;
          }

          matchedCount += store.positions.length;
          for (const position of store.positions) {
            evidence.push({
              minAge: position.hiringRequirements?.minAge ?? null,
              maxAge: position.hiringRequirements?.maxAge ?? null,
            });
          }
        }
      }

      return {
        evidence,
        matchedCount,
        total,
        isComplete: true,
      };
    },
  };
}

export function createDulidayApiAgeSource({
  token,
  jobListUrl,
}: {
  token: string;
  jobListUrl: string;
}): AgeEligibilitySource {
  return {
    name: "duliday-api",
    async collect(query) {
      try {
        const payload = await fetchJobListPage(token, jobListUrl, 1, JOB_LIST_PAGE_SIZE, {
          brandAlias: query.brandAlias ?? null,
          cityName: query.cityName ?? null,
        });
        const { items, total } = extractResults(payload);
        const hasAdditionalPages = total > items.length && items.length >= JOB_LIST_PAGE_SIZE;

        const brandFilters = normalizeFilters(
          buildBrandCandidates(query.brandAlias, query.cityName),
        );
        const cityFilters = normalizeFilters(buildCityCandidates(query.cityName));
        const regionFilter = normalizeText(query.regionName);
        const evidence: AgeEvidence[] = [];
        let matchedCount = 0;

        for (const item of items) {
          if (!isRecord(item)) {
            continue;
          }
          const record = item;
          const basicInfo = isRecord(record.basicInfo)
            ? (record.basicInfo as Record<string, unknown>)
            : null;
          const storeInfo =
            basicInfo && isRecord(basicInfo.storeInfo)
              ? (basicInfo.storeInfo as Record<string, unknown>)
              : null;

          const itemBrand =
            pickText(record, ["brandAlias", "brandName", "brand", "organizationName"]) ||
            (basicInfo ? pickText(basicInfo, ["brandAlias", "brandName", "brand"]) : "");
          const itemCity =
            pickText(record, ["cityName", "storeCityName", "jobCityName"]) ||
            (storeInfo ? pickText(storeInfo, ["storeCityName", "cityName"]) : "");
          const itemRegion =
            pickText(record, ["regionName", "storeRegionName", "districtName"]) ||
            (storeInfo
              ? pickText(storeInfo, ["storeRegionName", "regionName", "districtName"])
              : "");
          const itemAddress =
            pickText(record, ["storeAddress", "jobAddress", "address", "storeExactAddress"]) ||
            (storeInfo
              ? pickText(storeInfo, ["storeAddress", "storeExactAddress", "address"])
              : "");

          if (!matchesTextCandidates(itemBrand, brandFilters)) {
            continue;
          }
          if (!matchesTextCandidates(itemCity, cityFilters)) {
            continue;
          }
          if (!matchesRegion([itemRegion, itemAddress], regionFilter)) {
            continue;
          }

          matchedCount += 1;
          const hiringRequirement = isRecord(record.hiringRequirement)
            ? record.hiringRequirement
            : undefined;
          const requirement = isRecord(hiringRequirement?.basicPersonalRequirements)
            ? hiringRequirement.basicPersonalRequirements
            : undefined;

          evidence.push({
            minAge: toNumber(requirement?.minAge ?? record.minAge),
            maxAge: toNumber(requirement?.maxAge ?? record.maxAge),
          });
        }

        return {
          evidence,
          matchedCount,
          total,
          isComplete: !hasAdditionalPages,
        };
      } catch {
        return createEmptyAgeEvidenceCollection();
      }
    },
  };
}

export function createDefaultAgeEligibilitySources({
  configData,
  token,
  jobListUrl,
}: {
  configData: ZhipinData;
  token?: string | null | undefined;
  jobListUrl?: string | null | undefined;
}): AgeEligibilitySource[] {
  const sources: AgeEligibilitySource[] = [createConfigDataAgeSource(configData)];
  if (token && jobListUrl) {
    sources.push(createDulidayApiAgeSource({ token, jobListUrl }));
  }
  return sources;
}

export async function collectAgeEvidenceFromSources({
  sources,
  ...query
}: AgeEligibilityQuery & {
  sources?: AgeEligibilitySource[] | undefined;
}): Promise<AgeEvidenceCollection> {
  let fallback = createEmptyAgeEvidenceCollection();

  for (const source of sources ?? []) {
    try {
      const collection = normalizeEvidenceCollection(await source.collect(query));
      if (collection.total === 0 && collection.matchedCount === 0 && collection.evidence.length === 0) {
        continue;
      }
      if (collection.isComplete && hasUsableAgeEvidence(collection.evidence)) {
        return collection;
      }
      if (fallback.total === 0 && fallback.matchedCount === 0 && fallback.evidence.length === 0) {
        fallback = collection;
      }
    } catch {
      continue;
    }
  }

  return fallback;
}

export function evaluateAgeEligibility({
  age,
  evidence,
  matchedCount,
  total,
  isComplete = true,
  strategy,
}: {
  age?: number | null;
  evidence: AgeEvidence[];
  matchedCount?: number | undefined;
  total?: number | undefined;
  isComplete?: boolean | undefined;
  strategy?: AgeQualificationPolicy;
}): AgeEligibilityResult {
  const normalizedEvidence = evidence
    .map((item) => AgeEvidenceSchema.safeParse(item))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
  const summary: AgeEligibilitySummary = {
    minAgeObserved: null,
    maxAgeObserved: null,
    matchedCount: matchedCount ?? normalizedEvidence.length,
    total: total ?? normalizedEvidence.length,
  };

  if (
    typeof age !== "number" ||
    !Number.isFinite(age) ||
    normalizedEvidence.length === 0 ||
    !isComplete
  ) {
    return {
      status: "unknown",
      summary,
      appliedStrategy: buildAppliedStrategy("unknown", strategy),
    };
  }

  let anyRange = false;
  let anyMatch = false;

  for (const item of normalizedEvidence) {
    const { minAge, maxAge } = item;

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

    const belowMin = minAge !== null && age < minAge;
    const aboveMax = maxAge !== null && age > maxAge;
    if (!belowMin && !aboveMax) {
      anyMatch = true;
    }
  }

  if (!anyRange) {
    return {
      status: "unknown",
      summary,
      appliedStrategy: buildAppliedStrategy("unknown", strategy),
    };
  }

  const status: AgeEligibilityStatus = anyMatch ? "pass" : "fail";
  return { status, summary, appliedStrategy: buildAppliedStrategy(status, strategy) };
}
