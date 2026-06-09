import type { AgentLLM, AgentLogger } from "@roll-agent/sdk";
import {
  CandidateLocationSignalSchema,
  type CandidateLocationSignal,
} from "@roll-agent/reply-authority-client";

const EXPECTED_JOB_SEPARATOR = "·";
const BRAND_POSITION_SEPARATOR = /[-－—–]/;
const RECENT_LOCATION_SIGNAL_MESSAGE_LIMIT = 12;
const EXPECTED_LOCATION_CONFIDENCE = 0.6;
const RULE_BASED_LOCATION_CONFIDENCE = 0.74;
const LOCATION_SIGNAL_LLM_TIMEOUT_MS = 8_000;
const LOCATION_SIGNAL_QUERY_PATTERN =
  /(附近|周边|旁边|就近|地址|位置|在哪里|在哪|哪里|哪边|远吗|太远|不远|地铁|号线|门店|工作地址)/u;
const EXPECTED_LOCATION_QUERY_PATTERN =
  /(有吗|还招|招吗|招聘吗|附近|周边|地址|门店|在哪里|在哪|哪里|哪边|远吗|太远|不远)/u;
const LOCATION_NAME_EVIDENCE_PATTERN =
  /[\p{Script=Han}A-Za-z0-9]{2,16}(?:地铁站|号线|区|县|镇|街道|路|坊|广场|商场|店)/u;
const RULE_BASED_LOCATION_PATTERNS = [
  /是在([^，。？！,.!?\s]{2,16})吗/u,
  /我在([^，。？！,.!?\s]{2,16}?)(?:附近|这边|那边|，|,|。|！|!|？|\?)/u,
  /([^，。？！,.!?\s]{2,16}?)(?:附近|周边|旁边|招兼职|有吗|还招)/u,
  /([^，。？！,.!?\s]{2,16}(?:地铁站|号线|区|镇|街道|路|坊|广场|商场|店))/u,
] as const;
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

type LocationSignalAnalysisInput = {
  readonly messages: readonly LocationSignalMessage[];
  readonly expectedLocation: string;
  readonly communicationPosition: string;
};

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

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function readLocationSignalItems(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (isPlainRecord(parsed) && Array.isArray(parsed["locationSignals"])) {
    return parsed["locationSignals"];
  }

  throw new Error("Location signal extraction did not produce a JSON array");
}

function parseLocationSignalsFromText(text: string): CandidateLocationSignal[] {
  return readLocationSignalItems(parseJsonFromText(text)).flatMap((item) => {
    const parsed = CandidateLocationSignalSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
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

function normalizeRuleBasedLocationText(value: string | null | undefined): string {
  return normalizeText(value)
    .replace(/^[那这]/u, "")
    .replace(/^(是在|我在|在|到|去|离)/u, "")
    .replace(/[吗呢啊呀吧了，。？！,.!?]+$/u, "")
    .trim();
}

function stripKnownContextText(text: string, input: LocationSignalEvidenceInput): string {
  const knownFragments = [normalizeText(input.communicationPosition)].filter(
    (fragment) => fragment.length >= 2,
  );

  return knownFragments.reduce(
    (current, fragment) => current.split(fragment).join(""),
    normalizeText(text),
  );
}

function shouldAttemptLocationSignalLlm(input: LocationSignalEvidenceInput): boolean {
  const candidateTexts = [
    input.latestCandidateMessage,
    ...input.recentMessages
      .filter((message) => message.sender === "candidate")
      .map((message) => message.content),
  ];

  return candidateTexts.some((text) => {
    const stripped = stripKnownContextText(text, input);
    return (
      LOCATION_SIGNAL_QUERY_PATTERN.test(stripped) ||
      LOCATION_NAME_EVIDENCE_PATTERN.test(stripped) ||
      hasExpectedLocationQuery(stripped, input)
    );
  });
}

function hasExpectedLocationQuery(text: string, input: LocationSignalEvidenceInput): boolean {
  const expectedLocation = normalizeText(input.expectedLocation);
  return (
    expectedLocation.length >= 2 &&
    normalizeText(text).includes(expectedLocation) &&
    EXPECTED_LOCATION_QUERY_PATTERN.test(text)
  );
}

function buildLocationSignalEvidenceInput(
  input: LocationSignalAnalysisInput,
): LocationSignalEvidenceInput {
  return {
    latestCandidateMessage: getLatestCandidateMessage(input.messages),
    recentMessages: getRecentHumanMessages(input.messages),
    expectedLocation: normalizeText(input.expectedLocation),
    communicationPosition: normalizeText(input.communicationPosition),
  };
}

export function shouldAnalyzeLocationSignals(input: LocationSignalAnalysisInput): boolean {
  return shouldAttemptLocationSignalLlm(buildLocationSignalEvidenceInput(input));
}

function inferRuleBasedLocationIntent(
  message: string,
): CandidateLocationSignal["intent"] | undefined {
  if (message.includes("地址")) {
    return "store_address";
  }
  if (/(附近|周边|旁边|就近|太远|远吗|离)/u.test(message)) {
    return "nearby_store";
  }
  return "expected_area";
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

function resolveRuleBasedLocationSignals(
  input: LocationSignalEvidenceInput,
): CandidateLocationSignal[] {
  const candidateMessages = getCandidateMessageTexts(input);
  if (candidateMessages.length === 0) {
    return [];
  }

  const signals: CandidateLocationSignal[] = [];
  const seen = new Set<string>();
  const city = normalizeText(input.expectedLocation);

  for (const message of candidateMessages) {
    for (const pattern of RULE_BASED_LOCATION_PATTERNS) {
      const rawText = pattern.exec(message)?.[1];
      const text = normalizeRuleBasedLocationText(rawText);
      const overlappingText = [...seen].find(
        (existingText) => existingText.includes(text) || text.includes(existingText),
      );
      if (!text || overlappingText !== undefined) {
        continue;
      }

      seen.add(text);
      const intent = inferRuleBasedLocationIntent(message);
      signals.push({
        text,
        source: "candidate_message",
        ...(city ? { city } : {}),
        ...(intent !== undefined ? { intent } : {}),
        confidence: RULE_BASED_LOCATION_CONFIDENCE,
      });
    }
  }

  return signals;
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
    "你要从 BOSS 直聘招聘对话中抽取候选人的地点查询证据。",
    "只抽取候选人明确提到、或能从给定对话历史和候选人资料中直接定位的地点文本。",
    "不要补全真实 POI，不要使用外部知识，不要把地点改写成门店名。",
    "text 必须逐字来自输入里的 latestCandidateMessage、recentMessages.content、expectedLocation 或 communicationPosition。",
    "如果无法确定地点，返回 []。",
    "只输出 JSON array，不要输出 Markdown，不要解释。",
    "",
    "字段：",
    "- text: 原文地点片段",
    "- source: candidate_message | conversation_history | candidate_expected_location | communication_position",
    "- city: 只有输入中可确认城市时才填",
    "- intent: nearby_store | store_address | expected_area，不确定时省略",
    "- confidence: 0 到 1",
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
  return mergeValidateAndRankLocationSignals(
    [
      ...parseLocationSignalsFromText(input.llmText),
      ...resolveRuleBasedLocationSignals(input),
      ...resolveWeakProfileLocationSignals(input),
    ],
    input,
  );
}

function resolveFallbackLocationSignals(
  input: LocationSignalEvidenceInput,
): CandidateLocationSignal[] {
  return mergeValidateAndRankLocationSignals(
    [...resolveRuleBasedLocationSignals(input), ...resolveWeakProfileLocationSignals(input)],
    input,
  );
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

export async function resolveLocationSignalsWithLlm(
  input: ResolveLocationSignalsInput,
): Promise<CandidateLocationSignal[]> {
  const evidenceInput = buildLocationSignalEvidenceInput(input);
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);

  if (!shouldAttemptLocationSignalLlm(evidenceInput)) {
    return resolveFallbackLocationSignals(evidenceInput);
  }

  try {
    const llmText = await waitForLocationSignalLlmText({
      llm: input.llm,
      prompt: buildLocationSignalPrompt(evidenceInput),
      timeoutMs,
    });
    return resolveLocationSignalsFromLlmText({ ...evidenceInput, llmText });
  } catch (error) {
    input.logger?.warn(
      `Location signal extraction failed; using fallback location signals: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return resolveFallbackLocationSignals(evidenceInput);
  }
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
