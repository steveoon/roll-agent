import { z } from "zod";

// ========== Constants ==========

const JOB_LIST_CACHE_TTL_MS = 60_000;
const JOB_LIST_PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 20_000;

// ========== Cache ==========

let jobListCache: { cacheKey: string; payload: unknown; fetchedAt: number } | null = null;
let inflightJobListRequest: { cacheKey: string; promise: Promise<unknown> } | null = null;

// ========== Env Helpers ==========

export function getDulidayJobListEndpoint(): string | undefined {
  const endpoint = process.env.DULIDAY_JOB_LIST_URL;
  return typeof endpoint === "string" && endpoint.trim().length > 0 ? endpoint : undefined;
}

export function getDulidayToken(): string | undefined {
  const token = process.env.DULIDAY_TOKEN;
  return typeof token === "string" && token.trim().length > 0 ? token : undefined;
}

// ========== Name Helpers ==========

export function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function buildCityCandidates(cityName?: string | null): string[] {
  const city = normalizeName(cityName);
  if (!city) return [];
  const candidates = new Set<string>([city]);
  if (city.endsWith("市")) candidates.add(city.slice(0, -1));
  else candidates.add(`${city}市`);
  return Array.from(candidates).filter(Boolean);
}

export function buildBrandCandidates(
  brandAlias?: string | null,
  cityName?: string | null,
): string[] {
  const brand = normalizeName(brandAlias);
  if (!brand) return [];
  const candidates = new Set<string>([brand]);
  const cityCandidates = buildCityCandidates(cityName);
  for (const city of cityCandidates) {
    if (brand.startsWith(city)) {
      const stripped = brand.slice(city.length).trim();
      if (stripped) candidates.add(stripped);
    }
  }
  return Array.from(candidates).filter(Boolean);
}

// ========== Response Parsing ==========

const jobListResponseSchema = z.object({
  data: z
    .object({
      result: z.array(z.unknown()).optional(),
      list: z.array(z.unknown()).optional(),
      total: z.number().optional(),
    })
    .nullable()
    .optional(),
  result: z.array(z.unknown()).optional(),
});

export function extractResults(payload: unknown): { items: unknown[]; total: number } {
  const parsed = jobListResponseSchema.safeParse(payload);
  if (!parsed.success) return { items: [], total: 0 };
  const data = parsed.data;
  const items =
    data.data?.result ?? data.data?.list ?? (Array.isArray(data.result) ? data.result : []);
  const total = data.data?.total ?? (Array.isArray(items) ? items.length : 0);
  return {
    items: Array.isArray(items) ? items : [],
    total: typeof total === "number" ? total : 0,
  };
}

// ========== Single Page Fetch (with cache) ==========

export const FULL_INCLUDE_OPTIONS = {
  includeBasicInfo: true,
  includeJobSalary: true,
  includeWelfare: true,
  includeHiringRequirement: true,
  includeWorkTime: true,
} as const;

export type FetchJobListIncludeOptions = Partial<
  Record<keyof typeof FULL_INCLUDE_OPTIONS, boolean>
>;

const DEFAULT_INCLUDE_OPTIONS: FetchJobListIncludeOptions = {
  includeBasicInfo: true,
  includeHiringRequirement: true,
};

export async function fetchJobListPage(
  token: string,
  endpoint: string,
  pageNum: number,
  pageSize: number,
  options?: {
    brandAlias?: string | null;
    cityName?: string | null;
    include?: FetchJobListIncludeOptions;
  },
): Promise<unknown> {
  const shouldUseCache = process.env.NODE_ENV !== "test";
  const brandCandidates = buildBrandCandidates(options?.brandAlias, options?.cityName);
  const cityCandidates = buildCityCandidates(options?.cityName);
  const includeOpts = options?.include ?? DEFAULT_INCLUDE_OPTIONS;
  const cacheKey = JSON.stringify({
    token,
    brandCandidates,
    cityCandidates,
    pageNum,
    includeOpts,
  });

  const now = Date.now();
  if (
    shouldUseCache &&
    jobListCache &&
    jobListCache.cacheKey === cacheKey &&
    now - jobListCache.fetchedAt < JOB_LIST_CACHE_TTL_MS
  ) {
    return jobListCache.payload;
  }
  if (shouldUseCache && inflightJobListRequest?.cacheKey === cacheKey) {
    return inflightJobListRequest.promise;
  }

  const requestPromise = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const queryParam: Record<string, unknown> = {};
    if (brandCandidates.length > 0) queryParam.brandAliasList = brandCandidates;
    if (cityCandidates.length > 0) queryParam.cityNameList = cityCandidates;
    const requestBody = {
      pageNum,
      pageSize,
      queryParam,
      options: includeOpts,
    };
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Duliday-Token": token },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Duliday job list fetch failed: ${response.status}`);
      const payload: unknown = await response.json();
      jobListCache = { cacheKey, payload, fetchedAt: Date.now() };
      return payload;
    } finally {
      clearTimeout(timeoutId);
      inflightJobListRequest = null;
    }
  })();

  if (shouldUseCache) inflightJobListRequest = { cacheKey, promise: requestPromise };
  return requestPromise;
}

// ========== All Pages Fetch ==========

export async function fetchAllJobListPages(
  token: string,
  endpoint: string,
  options?: {
    brandAlias?: string | null;
    cityName?: string | null;
    include?: FetchJobListIncludeOptions;
  },
): Promise<{ items: unknown[]; total: number }> {
  const allItems: unknown[] = [];
  let page = 1;
  let total = 0;

  while (true) {
    const payload = await fetchJobListPage(token, endpoint, page, JOB_LIST_PAGE_SIZE, options);
    const result = extractResults(payload);
    if (page === 1) total = result.total;
    allItems.push(...result.items);

    if (result.items.length < JOB_LIST_PAGE_SIZE || allItems.length >= total) {
      break;
    }
    page += 1;
  }

  return { items: allItems, total };
}
