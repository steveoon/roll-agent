/** Browser-safe vocabulary; provider capabilities are separate from configuration syntax. */
export const legacyThinkingLevels = ["off", "low", "medium", "high"] as const;
export const googleNoOffThinkingLevels = ["low", "medium", "high"] as const;
export const googleXhighThinkingLevels = ["low", "medium", "high", "xhigh"] as const;
export const openaiProHighOnlyThinkingLevels = ["high"] as const;
export const openaiProMediumHighThinkingLevels = ["medium", "high"] as const;
export const runtimeThinkingLevels = [...legacyThinkingLevels, "xhigh", "max"] as const;
export type LegacyThinkingLevel = (typeof legacyThinkingLevels)[number];
export type GoogleNoOffThinkingLevel = (typeof googleNoOffThinkingLevels)[number];
export type GoogleXhighThinkingLevel = (typeof googleXhighThinkingLevels)[number];
export type ApiThinkingLevel = LegacyThinkingLevel | GoogleXhighThinkingLevel;
export type ThinkingLevel = (typeof runtimeThinkingLevels)[number];

export class UnsupportedThinkingLevelError extends Error {}

// Independent Google Gemini 4 capability dimensions (matched on normalized terminal model ID only):
// 1. xhigh support: Neon & Hydrogen (aligned with @ai-sdk/google)
// 2. required thinking (no off/minimal): Argon, Carbon, Hydrogen & Neon
const GOOGLE_XHIGH_THINKING_MODEL_PATTERN = /^gemini-4-(?:hydrogen|neon)(?:-|$)/;
const GOOGLE_REQUIRED_THINKING_MODEL_PATTERN = /^gemini-4-(?:argon|carbon|hydrogen|neon)(?:-|$)/;
const OPENAI_GPT5_PRO_HIGH_ONLY_PATTERN = /^gpt-5-pro(?:-(\d{4})-(\d{2})-(\d{2}))?$/u;
const OPENAI_GPT5_PRO_MEDIUM_HIGH_PATTERN = /^gpt-5\.(?:2|4|5)-pro(?:-(\d{4})-(\d{2})-(\d{2}))?$/u;
const XAI_ALWAYS_REASONING_MODELS: ReadonlySet<string> = new Set([
  "grok-4.5",
  "grok-4.6",
  "grok-4.7",
]);

export function isValidIsoCalendarDateSuffix(
  yearText: string | undefined,
  monthText: string | undefined,
  dayText: string | undefined,
): boolean {
  if (yearText === undefined && monthText === undefined && dayText === undefined) {
    return true;
  }
  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    return false;
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Intersects OpenAI Pro model-card reasoning efforts with the API levels Core currently sends:
 * - gpt-5-pro (and valid YYYY-MM-DD aliases): high only
 * - gpt-5.2-pro / gpt-5.4-pro / gpt-5.5-pro (and valid YYYY-MM-DD aliases): medium, high
 */
export function resolveOpenAiProThinkingLevels(
  modelName: string,
): readonly LegacyThinkingLevel[] | undefined {
  const normalized = modelName.trim().toLowerCase();
  const highOnly = OPENAI_GPT5_PRO_HIGH_ONLY_PATTERN.exec(normalized);
  if (highOnly !== null && isValidIsoCalendarDateSuffix(highOnly[1], highOnly[2], highOnly[3])) {
    return openaiProHighOnlyThinkingLevels;
  }
  const mediumHigh = OPENAI_GPT5_PRO_MEDIUM_HIGH_PATTERN.exec(normalized);
  if (
    mediumHigh !== null &&
    isValidIsoCalendarDateSuffix(mediumHigh[1], mediumHigh[2], mediumHigh[3])
  ) {
    return openaiProMediumHighThinkingLevels;
  }
  return undefined;
}

/**
 * Normalize a Google model identifier to its terminal segment so resource prefixes like
 * `projects/<project>/.../models/<model>` cannot pollute capability matching, while keeping
 * `models/`, dot-prefixed aliases (e.g. `google.gemini-...`), and version suffixes intact.
 */
export function normalizeGoogleModelId(modelName: string): string {
  const trimmed = modelName.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  const segment = (slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1)).toLowerCase();
  if (segment.startsWith("gemini-")) {
    return segment;
  }
  const dotIndex = segment.lastIndexOf(".gemini-");
  return dotIndex === -1 ? segment : segment.slice(dotIndex + 1);
}

export function supportsGoogleXhighThinking(modelName: string): boolean {
  return GOOGLE_XHIGH_THINKING_MODEL_PATTERN.test(normalizeGoogleModelId(modelName));
}

export function requiresGoogleThinking(modelName: string): boolean {
  return GOOGLE_REQUIRED_THINKING_MODEL_PATTERN.test(normalizeGoogleModelId(modelName));
}

export function requiresXaiChatThinking(modelName: string): boolean {
  return XAI_ALWAYS_REASONING_MODELS.has(modelName);
}

export function assertXaiChatThinkingSupported(
  modelName: string,
  level: LegacyThinkingLevel,
): void {
  if (level === "off" && requiresXaiChatThinking(modelName)) {
    throw new UnsupportedThinkingLevelError(
      `模型 ${modelName} 不支持关闭思考。请将 runtime.thinking-level 设为 low 或更高。`,
    );
  }
}

function isAllowedThinkingLevel<T extends ThinkingLevel>(
  level: ThinkingLevel,
  allowed: readonly T[],
): level is T {
  return allowed.some((candidate) => candidate === level);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return runtimeThinkingLevels.some((level) => level === value);
}

export function isLegacyThinkingLevel(level: ThinkingLevel): level is LegacyThinkingLevel {
  return isAllowedThinkingLevel(level, legacyThinkingLevels);
}

export function isGoogleXhighThinkingLevel(
  level: ThinkingLevel,
): level is GoogleXhighThinkingLevel {
  return isAllowedThinkingLevel(level, googleXhighThinkingLevels);
}

export function apiThinkingLevels(
  provider: string,
  modelName?: string,
): readonly ApiThinkingLevel[] {
  if (provider === "google" && modelName !== undefined) {
    if (supportsGoogleXhighThinking(modelName)) {
      return googleXhighThinkingLevels;
    }
    if (requiresGoogleThinking(modelName)) {
      return googleNoOffThinkingLevels;
    }
  }
  if (provider === "openai" && modelName !== undefined) {
    const proLevels = resolveOpenAiProThinkingLevels(modelName);
    if (proLevels !== undefined) {
      return proLevels;
    }
  }
  return legacyThinkingLevels;
}

export function defaultApiThinkingLevel(provider: string, modelName?: string): ApiThinkingLevel {
  const allowed = apiThinkingLevels(provider, modelName);
  if (allowed.includes("medium")) {
    return "medium";
  }
  return allowed[0] ?? "medium";
}

export function requireLegacyThinkingLevel(
  level: ThinkingLevel,
  provider: string,
): LegacyThinkingLevel {
  if (!isLegacyThinkingLevel(level)) {
    throw new UnsupportedThinkingLevelError(
      `API Provider "${provider}" 不支持推理强度 "${level}"；可选档位：${legacyThinkingLevels.join(", ")}。`,
    );
  }
  return level;
}

export function requireGoogleRequiredThinkingLevel(
  level: ThinkingLevel,
  modelName: string,
): GoogleXhighThinkingLevel {
  const allowed = supportsGoogleXhighThinking(modelName)
    ? googleXhighThinkingLevels
    : googleNoOffThinkingLevels;
  if (!isAllowedThinkingLevel(level, allowed)) {
    throw new UnsupportedThinkingLevelError(
      `模型 ${modelName} 不支持推理强度 "${level}"；可选档位：${allowed.join(", ")}。`,
    );
  }
  return level;
}

export function requireOpenAiProThinkingLevel(
  level: ThinkingLevel,
  modelName: string,
  allowed: readonly LegacyThinkingLevel[],
): LegacyThinkingLevel {
  if (!isAllowedThinkingLevel(level, allowed)) {
    throw new UnsupportedThinkingLevelError(
      `模型 ${modelName} 不支持推理强度 "${level}"；可选档位：${allowed.join(", ")}。`,
    );
  }
  return level;
}

export function requireApiThinkingLevel(
  level: ThinkingLevel,
  provider: string,
  modelName?: string,
): ApiThinkingLevel {
  if (provider === "google" && modelName !== undefined && requiresGoogleThinking(modelName)) {
    return requireGoogleRequiredThinkingLevel(level, modelName);
  }
  if (provider === "openai" && modelName !== undefined) {
    const proLevels = resolveOpenAiProThinkingLevels(modelName);
    if (proLevels !== undefined) {
      return requireOpenAiProThinkingLevel(level, modelName, proLevels);
    }
  }
  return requireLegacyThinkingLevel(level, provider);
}

function isSameEffectiveApiModel(
  leftProvider: string,
  leftModel: string | undefined,
  rightProvider: string,
  rightModel: string | undefined,
): boolean {
  if (leftProvider !== rightProvider) return false;
  if (leftModel === undefined || rightModel === undefined) return leftModel === rightModel;
  if (leftProvider === "google") {
    return normalizeGoogleModelId(leftModel) === normalizeGoogleModelId(rightModel);
  }
  return leftModel.trim().toLowerCase() === rightModel.trim().toLowerCase();
}

function requireChatOrSamplingThinkingLevel(
  level: ThinkingLevel,
  provider: string,
  modelName?: string,
): ApiThinkingLevel {
  const validated = requireApiThinkingLevel(level, provider, modelName);
  if (provider === "xai" && modelName !== undefined && validated !== "xhigh") {
    assertXaiChatThinkingSupported(modelName, validated);
  }
  return validated;
}

/** ask/run own an API model, not the subscription or distinct chat model selected in runtime. */
export function apiSamplingThinkingLevel(
  runtime: {
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
    readonly thinkingLevel: ThinkingLevel;
  },
  apiProvider: string,
  warn: (message: string) => void,
  apiModel?: string,
): ApiThinkingLevel {
  const fallbackLevel = defaultApiThinkingLevel(apiProvider, apiModel);
  const sourceProvider = runtime.provider ?? apiProvider;
  if (sourceProvider === "chatgpt") {
    if (runtime.thinkingLevel === "xhigh" || runtime.thinkingLevel === "max") {
      warn(
        `ChatGPT 聊天强度 ${runtime.thinkingLevel} 不适用于独立 API Sampling；ask/run 的 ${apiProvider} 模型使用默认 ${fallbackLevel}，不切换模型或授权通道。`,
      );
      return fallbackLevel;
    }
    try {
      return requireChatOrSamplingThinkingLevel(runtime.thinkingLevel, apiProvider, apiModel);
    } catch (error) {
      if (!(error instanceof UnsupportedThinkingLevelError)) throw error;
      const targetLabel = apiModel ? `${apiProvider}/${apiModel}` : apiProvider;
      warn(
        `ChatGPT 聊天强度 ${runtime.thinkingLevel} 不适用于独立 API Sampling 模型 ${targetLabel}；ask/run 使用默认 ${fallbackLevel}，不切换模型或授权通道。`,
      );
      return fallbackLevel;
    }
  }

  const sourceModel = runtime.model ?? apiModel;
  const validatedSourceLevel = requireChatOrSamplingThinkingLevel(
    runtime.thinkingLevel,
    sourceProvider,
    sourceModel,
  );
  if (isSameEffectiveApiModel(sourceProvider, sourceModel, apiProvider, apiModel)) {
    return validatedSourceLevel;
  }

  try {
    return requireChatOrSamplingThinkingLevel(validatedSourceLevel, apiProvider, apiModel);
  } catch (error) {
    if (!(error instanceof UnsupportedThinkingLevelError)) throw error;
    const sourceLabel = sourceModel ? `${sourceProvider}/${sourceModel}` : sourceProvider;
    const targetLabel = apiModel ? `${apiProvider}/${apiModel}` : apiProvider;
    warn(
      `聊天模型 ${sourceLabel} 的推理强度 ${validatedSourceLevel} 不适用于独立 API Sampling 模型 ${targetLabel}；ask/run 使用默认 ${fallbackLevel}，不切换模型或授权通道。`,
    );
    return fallbackLevel;
  }
}

export function chatGptThinkingLevels(model?: {
  readonly reasoningEfforts?: readonly string[] | undefined;
}): readonly ThinkingLevel[] {
  const efforts = model?.reasoningEfforts;
  if (efforts === undefined) return legacyThinkingLevels;
  return runtimeThinkingLevels.filter((level) =>
    efforts.includes(level === "off" ? "none" : level),
  );
}
