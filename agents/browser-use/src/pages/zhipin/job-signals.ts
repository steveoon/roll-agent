import { createHash } from "node:crypto";
import type { AgentLLM, AgentLogger } from "@roll-agent/sdk";
import {
  CandidateLocationSignalSchema,
  type CandidateLocationSignal,
} from "@roll-agent/reply-authority-client";
import { z } from "zod";

const EXPECTED_JOB_SEPARATOR = "·";
const BRAND_POSITION_SEPARATOR = /[-－—–]/;
const RECENT_LOCATION_SIGNAL_MESSAGE_LIMIT = 12;
const EXPECTED_LOCATION_CONFIDENCE = 0.6;
const LOCATION_SIGNAL_LLM_TIMEOUT_MS = 15_000;
const LOCATION_SIGNAL_CACHE_TTL_MS = 5 * 60_000;
const LOCATION_SIGNAL_CACHE_MAX_ENTRIES = 200;

export const LocationSignalAnalysisPathValues = [
  "llm",
  "fallback",
  "profile_only",
  "speculative",
  "none",
] as const;

export type LocationSignalAnalysisPath = (typeof LocationSignalAnalysisPathValues)[number];

export const LocationSignalInquiryTypeValues = [
  "location_inquiry",
  "non_location_inquiry",
] as const;

export type LocationSignalInquiryType = (typeof LocationSignalInquiryTypeValues)[number];

export type LocationSignalResolution = {
  readonly signals: readonly CandidateLocationSignal[];
  readonly analysisPath: LocationSignalAnalysisPath;
  readonly inquiryType?: LocationSignalInquiryType;
};
const LocationSignalLlmDecisionSchema = z.object({
  inquiryType: z.enum(LocationSignalInquiryTypeValues),
  reason: z.string().trim().max(200).optional(),
  locationSignals: z.array(CandidateLocationSignalSchema).default([]),
});
type LocationSignalLlmDecision = z.infer<typeof LocationSignalLlmDecisionSchema>;

const LOCATION_SIGNAL_SOURCE_PRIORITY: Readonly<Record<CandidateLocationSignal["source"], number>> =
  {
    candidate_message: 0,
    conversation_history: 1,
    candidate_expected_location: 2,
    communication_position: 3,
  };

export type LocationSignalMessage = {
  readonly index: number;
  readonly sender: "candidate" | "recruiter" | "system";
  readonly content: string;
};

type LocationSignalEvidenceInput = {
  readonly latestCandidateMessage: string;
  readonly recentMessages: readonly LocationSignalMessage[];
  readonly expectedLocation: string;
  readonly communicationPosition: string;
};

type ResolveLocationSignalsInput = {
  readonly llm: AgentLLM;
  readonly logger?: Pick<AgentLogger, "warn"> | undefined;
  readonly messages: readonly LocationSignalMessage[];
  readonly expectedLocation: string;
  readonly communicationPosition: string;
  readonly timeoutMs?: number | undefined;
};

type LocationSignalResolutionCacheEntry = {
  readonly createdAtMs: number;
  readonly resolution: LocationSignalResolution;
};

const locationSignalResolutionCache = new Map<string, LocationSignalResolutionCacheEntry>();
const pendingLocationSignalResolutions = new Map<string, Promise<LocationSignalResolution>>();

class LocationSignalExtractionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Location signal extraction timed out after ${timeoutMs}ms`);
    this.name = "LocationSignalExtractionTimeoutError";
  }
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return LOCATION_SIGNAL_LLM_TIMEOUT_MS;
  }

  return Math.floor(value);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function getLatestCandidateMessage(messages: readonly LocationSignalMessage[]): string {
  const latest = [...messages]
    .reverse()
    .find((message) => message.sender === "candidate" && message.content.trim().length > 0);
  return latest?.content.trim() ?? "";
}

function getRecentHumanMessages(
  messages: readonly LocationSignalMessage[],
): readonly LocationSignalMessage[] {
  return messages
    .filter(
      (message) =>
        (message.sender === "candidate" || message.sender === "recruiter") &&
        message.content.trim().length > 0,
    )
    .slice(-RECENT_LOCATION_SIGNAL_MESSAGE_LIMIT);
}

function getJsonTextCandidates(text: string): ReadonlyArray<string> {
  const trimmed = text.trim();
  const candidates = new Set<string>();

  if (trimmed) {
    candidates.add(trimmed);
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fencedJson = fenceMatch?.[1]?.trim();
  if (fencedJson) {
    candidates.add(fencedJson);
  }

  const firstArrayBracket = trimmed.indexOf("[");
  const lastArrayBracket = trimmed.lastIndexOf("]");
  if (firstArrayBracket >= 0 && lastArrayBracket > firstArrayBracket) {
    candidates.add(trimmed.slice(firstArrayBracket, lastArrayBracket + 1).trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(trimmed.slice(firstBrace, lastBrace + 1).trim());
  }

  return [...candidates];
}

function parseJsonFromText(text: string): unknown {
  for (const candidate of getJsonTextCandidates(text)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {}
  }

  throw new Error("Location signal extraction did not produce valid JSON");
}

function parseLocationSignalDecision(parsed: unknown): LocationSignalLlmDecision {
  const decision = LocationSignalLlmDecisionSchema.safeParse(parsed);
  if (decision.success) {
    return decision.data;
  }

  throw new Error("Location signal extraction did not produce a valid JSON decision");
}

function parseLocationSignalDecisionFromText(text: string): LocationSignalLlmDecision {
  return parseLocationSignalDecision(parseJsonFromText(text));
}

function resolveWeakProfileLocationSignals(
  input: LocationSignalEvidenceInput,
): CandidateLocationSignal[] {
  const expectedLocation = normalizeText(input.expectedLocation);
  if (!expectedLocation) {
    return [];
  }

  return [
    {
      text: expectedLocation,
      source: "candidate_expected_location",
      city: expectedLocation,
      intent: "expected_area",
      confidence: EXPECTED_LOCATION_CONFIDENCE,
    },
  ];
}

function buildLocationSignalEvidenceInput(
  input: Pick<
    ResolveLocationSignalsInput,
    "messages" | "expectedLocation" | "communicationPosition"
  >,
): LocationSignalEvidenceInput {
  return {
    latestCandidateMessage: getLatestCandidateMessage(input.messages),
    recentMessages: getRecentHumanMessages(input.messages),
    expectedLocation: normalizeText(input.expectedLocation),
    communicationPosition: normalizeText(input.communicationPosition),
  };
}

function cloneLocationSignal(signal: CandidateLocationSignal): CandidateLocationSignal {
  return { ...signal };
}

function cloneLocationSignalResolution(
  resolution: LocationSignalResolution,
): LocationSignalResolution {
  return {
    analysisPath: resolution.analysisPath,
    signals: resolution.signals.map(cloneLocationSignal),
    ...(resolution.inquiryType !== undefined ? { inquiryType: resolution.inquiryType } : {}),
  };
}

function buildLocationSignalCacheKey(input: {
  readonly evidenceInput: LocationSignalEvidenceInput;
  readonly timeoutMs: number;
}): string {
  const payload = {
    latestCandidateMessage: input.evidenceInput.latestCandidateMessage,
    recentMessages: input.evidenceInput.recentMessages.map((message) => ({
      index: message.index,
      sender: message.sender,
      content: normalizeText(message.content),
    })),
    expectedLocation: input.evidenceInput.expectedLocation,
    communicationPosition: input.evidenceInput.communicationPosition,
    timeoutMs: input.timeoutMs,
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function readCachedLocationSignalResolution(
  cacheKey: string,
  nowMs: number,
): LocationSignalResolution | undefined {
  const cached = locationSignalResolutionCache.get(cacheKey);
  if (cached === undefined) {
    return undefined;
  }

  if (nowMs - cached.createdAtMs > LOCATION_SIGNAL_CACHE_TTL_MS) {
    locationSignalResolutionCache.delete(cacheKey);
    return undefined;
  }

  return cloneLocationSignalResolution(cached.resolution);
}

function writeCachedLocationSignalResolution(input: {
  readonly cacheKey: string;
  readonly resolution: LocationSignalResolution;
  readonly nowMs: number;
}): void {
  if (input.resolution.analysisPath === "fallback") {
    return;
  }

  locationSignalResolutionCache.set(input.cacheKey, {
    createdAtMs: input.nowMs,
    resolution: cloneLocationSignalResolution(input.resolution),
  });

  while (locationSignalResolutionCache.size > LOCATION_SIGNAL_CACHE_MAX_ENTRIES) {
    const oldestKey = locationSignalResolutionCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    locationSignalResolutionCache.delete(oldestKey);
  }
}

function getCandidateMessageTexts(input: LocationSignalEvidenceInput): readonly string[] {
  const texts: string[] = [];
  const seen = new Set<string>();
  const append = (value: string) => {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    texts.push(normalized);
  };

  append(input.latestCandidateMessage);
  for (const message of [...input.recentMessages].reverse()) {
    if (message.sender === "candidate") {
      append(message.content);
    }
  }

  return texts;
}

function hasCityEvidence(city: string, input: LocationSignalEvidenceInput): boolean {
  if (!city) {
    return false;
  }

  return [
    input.latestCandidateMessage,
    ...input.recentMessages.map((message) => message.content),
    input.expectedLocation,
    input.communicationPosition,
  ].some((sourceText) => normalizeText(sourceText).includes(city));
}

function normalizeLocationSignal(
  signal: CandidateLocationSignal,
  input: LocationSignalEvidenceInput,
): CandidateLocationSignal {
  const text = normalizeText(signal.text);
  const isExpectedLocationSignal = signal.source === "candidate_expected_location";
  const candidateCity = normalizeText(signal.city) || (isExpectedLocationSignal ? text : "");
  const city = hasCityEvidence(candidateCity, input) ? candidateCity : "";
  const confidence = isExpectedLocationSignal
    ? Math.min(clampConfidence(signal.confidence), EXPECTED_LOCATION_CONFIDENCE)
    : clampConfidence(signal.confidence);
  const intent = isExpectedLocationSignal ? "expected_area" : signal.intent;

  return {
    text,
    source: signal.source,
    confidence,
    ...(city ? { city } : {}),
    ...(intent !== undefined ? { intent } : {}),
  };
}

function getEvidenceTexts(
  input: LocationSignalEvidenceInput,
  source: CandidateLocationSignal["source"],
): readonly string[] {
  if (source === "candidate_message") {
    return getCandidateMessageTexts(input);
  }
  if (source === "conversation_history") {
    return input.recentMessages.map((message) => message.content);
  }
  if (source === "candidate_expected_location") {
    return [input.expectedLocation];
  }
  return [input.communicationPosition];
}

function hasOriginalEvidence(
  signal: CandidateLocationSignal,
  input: LocationSignalEvidenceInput,
): boolean {
  const text = normalizeText(signal.text);
  if (!text) {
    return false;
  }

  return getEvidenceTexts(input, signal.source).some((sourceText) =>
    normalizeText(sourceText).includes(text),
  );
}

function shouldReplaceLocationSignal(
  existing: CandidateLocationSignal,
  candidate: CandidateLocationSignal,
): boolean {
  const existingPriority = LOCATION_SIGNAL_SOURCE_PRIORITY[existing.source];
  const candidatePriority = LOCATION_SIGNAL_SOURCE_PRIORITY[candidate.source];
  return (
    candidatePriority < existingPriority ||
    (candidatePriority === existingPriority && candidate.confidence > existing.confidence)
  );
}

function mergeValidateAndRankLocationSignals(
  signals: readonly CandidateLocationSignal[],
  input: LocationSignalEvidenceInput,
): CandidateLocationSignal[] {
  const byText = new Map<string, CandidateLocationSignal>();

  for (const signal of signals) {
    const normalized = normalizeLocationSignal(signal, input);
    if (!hasOriginalEvidence(normalized, input)) {
      continue;
    }

    const key = normalized.text.toLocaleLowerCase("zh-CN");
    const existing = byText.get(key);
    if (existing === undefined || shouldReplaceLocationSignal(existing, normalized)) {
      byText.set(key, normalized);
    }
  }

  return [...byText.values()].sort((left, right) => {
    const priorityDelta =
      LOCATION_SIGNAL_SOURCE_PRIORITY[left.source] - LOCATION_SIGNAL_SOURCE_PRIORITY[right.source];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return right.confidence - left.confidence;
  });
}

function buildLocationSignalPrompt(input: LocationSignalEvidenceInput): string {
  return [
    "你要判断 BOSS 直聘候选人的最新消息是不是地点咨询，并抽取可验证的地点证据。",
    "先判断 inquiryType，再决定是否输出 locationSignals。",
    "",
    "地点咨询 location_inquiry 包括：",
    "- 候选人询问门店/工作地址/在哪/远不远/附近有没有/某区域是否还招/能否就近安排。",
    "- 候选人提到自己所在区域、地铁站、线路、商圈、区县，并用来询问距离、门店或岗位可用性。",
    "- 最新消息是“那边远吗/那徐家汇呢”这类上下文指代时，可以用 recentMessages 里的地点作为证据。",
    "",
    "非地点咨询 non_location_inquiry 包括：",
    "- 打招呼、发简历、问是否还招、问薪资、问日结周结、问兼职/全职、问人数、问管吃住、问岗位细节。",
    "- “就近分配/就近安排”只出现在岗位名、招聘方描述或 communicationPosition 中，但候选人没有询问地点。",
    "- latestCandidateMessage 只是“请问/您好/贵公司/老板”等礼貌开头，本身不是地点。",
    "",
    "输出规则：",
    "- 如果 inquiryType 是 non_location_inquiry，locationSignals 必须是 []。",
    "- 如果 inquiryType 是 location_inquiry，只抽取候选人明确提到、或能从给定对话历史和资料中直接定位的地点文本。",
    "- expectedLocation 只是候选人资料里的城市/区域弱信号，不能把非地点咨询变成地点咨询。",
    "- 不要补全真实 POI，不要使用外部知识，不要把地点改写成门店名。",
    "- text 必须逐字来自输入里的 latestCandidateMessage、recentMessages.content、expectedLocation 或 communicationPosition。",
    "- city 只有输入中可确认城市时才填。",
    "- 不确定 intent 时省略。",
    "- 只输出 JSON object，不要输出 Markdown，不要解释。",
    "",
    "JSON schema：",
    "{",
    '  "inquiryType": "location_inquiry | non_location_inquiry",',
    '  "reason": "简短说明判断依据",',
    '  "locationSignals": [',
    "    {",
    '      "text": "原文地点片段",',
    '      "source": "candidate_message | conversation_history | candidate_expected_location | communication_position",',
    '      "city": "输入中可确认的城市，可省略",',
    '      "intent": "nearby_store | store_address | expected_area，可省略",',
    '      "confidence": 0.0',
    "    }",
    "  ]",
    "}",
    "",
    "[Input JSON]",
    JSON.stringify(
      {
        latestCandidateMessage: input.latestCandidateMessage,
        recentMessages: input.recentMessages.map((message) => ({
          index: message.index,
          sender: message.sender,
          content: message.content,
        })),
        expectedLocation: input.expectedLocation,
        communicationPosition: input.communicationPosition,
      },
      null,
      2,
    ),
  ].join("\n");
}

export function resolveLocationSignalsFromLlmText(
  input: LocationSignalEvidenceInput & { readonly llmText: string },
): CandidateLocationSignal[] {
  return resolveLocationSignalResolutionFromLlmText(input).signals.map(cloneLocationSignal);
}

function resolveLocationSignalResolutionFromLlmText(
  input: LocationSignalEvidenceInput & { readonly llmText: string },
): LocationSignalResolution {
  const decision = parseLocationSignalDecisionFromText(input.llmText);
  if (decision.inquiryType === "non_location_inquiry") {
    return {
      signals: [],
      analysisPath: "llm",
      inquiryType: "non_location_inquiry",
    };
  }

  return {
    signals: mergeValidateAndRankLocationSignals(
      [...decision.locationSignals, ...resolveWeakProfileLocationSignals(input)],
      input,
    ),
    analysisPath: "llm",
    inquiryType: "location_inquiry",
  };
}

function resolveFallbackLocationSignals(
  input: LocationSignalEvidenceInput,
): CandidateLocationSignal[] {
  return mergeValidateAndRankLocationSignals(resolveWeakProfileLocationSignals(input), input);
}

async function waitForLocationSignalLlmText(input: {
  readonly llm: AgentLLM;
  readonly prompt: string;
  readonly timeoutMs: number;
}): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      input.llm.generateText(input.prompt),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new LocationSignalExtractionTimeoutError(input.timeoutMs));
        }, input.timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function hasStrongLocationSignals(signals: readonly CandidateLocationSignal[]): boolean {
  return signals.some((signal) => signal.source !== "candidate_expected_location");
}

async function resolveUncachedLocationSignals(input: {
  readonly llm: AgentLLM;
  readonly logger?: Pick<AgentLogger, "warn"> | undefined;
  readonly evidenceInput: LocationSignalEvidenceInput;
  readonly timeoutMs: number;
}): Promise<LocationSignalResolution> {
  try {
    const llmText = await waitForLocationSignalLlmText({
      llm: input.llm,
      prompt: buildLocationSignalPrompt(input.evidenceInput),
      timeoutMs: input.timeoutMs,
    });
    return resolveLocationSignalResolutionFromLlmText({ ...input.evidenceInput, llmText });
  } catch (error) {
    input.logger?.warn(
      `Location signal extraction failed; using fallback location signals: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      signals: resolveFallbackLocationSignals(input.evidenceInput),
      analysisPath: "fallback",
    };
  }
}

export async function resolveLocationSignals(
  input: ResolveLocationSignalsInput,
): Promise<LocationSignalResolution> {
  const evidenceInput = buildLocationSignalEvidenceInput(input);
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  const cacheKey = buildLocationSignalCacheKey({ evidenceInput, timeoutMs });
  const nowMs = Date.now();
  const cached = readCachedLocationSignalResolution(cacheKey, nowMs);

  if (cached !== undefined) {
    return cached;
  }

  if (getCandidateMessageTexts(evidenceInput).length === 0) {
    const resolution: LocationSignalResolution = {
      signals: resolveFallbackLocationSignals(evidenceInput),
      analysisPath: "profile_only",
    };
    writeCachedLocationSignalResolution({ cacheKey, resolution, nowMs });
    return resolution;
  }

  const pending = pendingLocationSignalResolutions.get(cacheKey);
  if (pending !== undefined) {
    return cloneLocationSignalResolution(await pending);
  }

  const pendingResolution = resolveUncachedLocationSignals({
    llm: input.llm,
    logger: input.logger,
    evidenceInput,
    timeoutMs,
  });
  pendingLocationSignalResolutions.set(cacheKey, pendingResolution);

  try {
    const resolution = await pendingResolution;
    writeCachedLocationSignalResolution({ cacheKey, resolution, nowMs: Date.now() });
    return cloneLocationSignalResolution(resolution);
  } finally {
    pendingLocationSignalResolutions.delete(cacheKey);
  }
}

export function clearLocationSignalResolutionCacheForTest(): void {
  locationSignalResolutionCache.clear();
  pendingLocationSignalResolutions.clear();
}

export async function resolveLocationSignalsWithLlm(
  input: ResolveLocationSignalsInput,
): Promise<CandidateLocationSignal[]> {
  const resolution = await resolveLocationSignals(input);
  return [...resolution.signals];
}

export function resolvePreferredBrand(communicationPosition: string): string | undefined {
  const normalizedPosition = normalizeText(communicationPosition);
  if (!normalizedPosition || !BRAND_POSITION_SEPARATOR.test(normalizedPosition)) {
    return undefined;
  }

  const [preferredBrand = ""] = normalizedPosition.split(BRAND_POSITION_SEPARATOR);
  const normalizedBrand = normalizeText(preferredBrand);

  return normalizedBrand || undefined;
}

export function resolveExpectedSignals(expectedJobText: string): {
  expectedLocation: string;
  expectedPosition: string;
} {
  const normalizedText = normalizeText(expectedJobText);
  if (!normalizedText) {
    return {
      expectedLocation: "",
      expectedPosition: "",
    };
  }

  const [expectedLocation = "", expectedPosition = ""] = normalizedText
    .split(EXPECTED_JOB_SEPARATOR)
    .map((part) => normalizeText(part));

  return {
    expectedLocation,
    expectedPosition,
  };
}

function formatLocationSignalParts(signals: readonly CandidateLocationSignal[]): string {
  const hasStrongSignals = hasStrongLocationSignals(signals);
  const displaySignals = hasStrongSignals
    ? signals.filter((signal) => signal.source !== "candidate_expected_location")
    : signals;
  const parts = displaySignals.slice(0, 3).map((signal) => {
    const weakMarker = signal.source === "candidate_expected_location" ? "（弱）" : "";
    return `${signal.text}${weakMarker}`;
  });
  const overflow = displaySignals.length > 3 ? ` 等${String(displaySignals.length)}项` : "";
  return `${parts.join("、")}${overflow}`;
}

function isLocationSignalResolution(
  value: LocationSignalResolution | readonly CandidateLocationSignal[],
): value is LocationSignalResolution {
  return !Array.isArray(value) && "analysisPath" in value && "signals" in value;
}

export function formatLocationSignalsVisualLabel(
  resolution: LocationSignalResolution | readonly CandidateLocationSignal[],
): string {
  const signals = isLocationSignalResolution(resolution) ? resolution.signals : resolution;
  const analysisPath = isLocationSignalResolution(resolution) ? resolution.analysisPath : undefined;
  const inquiryType = isLocationSignalResolution(resolution) ? resolution.inquiryType : undefined;

  if (signals.length === 0) {
    if (inquiryType === "non_location_inquiry") {
      return "非地点咨询";
    }
    return analysisPath === "profile_only" ? "" : "未识别到地点线索";
  }

  const summary = formatLocationSignalParts(signals);
  const onlyWeakProfileSignals = !hasStrongLocationSignals(signals);

  if (onlyWeakProfileSignals) {
    if (analysisPath === "profile_only") {
      return `资料城市提示：${summary}`;
    }
    return "未识别到地点线索";
  }

  if (analysisPath === "fallback") {
    return `已识别地点（兜底）：${summary}`;
  }

  return `已识别地点：${summary}`;
}

export function resolveConversationSignals(input: {
  communicationPosition: string;
  expectedJobText: string;
}): {
  communicationPosition: string;
  expectedLocation: string;
  expectedPosition: string;
  preferredBrand?: string;
} {
  const communicationPosition = normalizeText(input.communicationPosition);
  const { expectedLocation, expectedPosition } = resolveExpectedSignals(input.expectedJobText);
  const preferredBrand = resolvePreferredBrand(communicationPosition);

  return {
    communicationPosition,
    expectedLocation,
    expectedPosition,
    ...(preferredBrand !== undefined ? { preferredBrand } : {}),
  };
}
