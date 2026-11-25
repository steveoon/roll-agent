import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogle, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { createXai } from "@ai-sdk/xai";
import { wrapLanguageModel } from "ai";
import type { ThreadEffortCapability } from "@roll-agent/protocol";
import { projectAnthropicStrictToolSchema } from "./anthropic-tool-schema.ts";
import {
  omitForeignEmptyAssistantTextParts,
  shouldRetainEmptyReasoningPart,
} from "./foreign-empty-text.ts";
import { applyOpenAiResponsesToolStrictDefaults } from "./openai-tool-strict.ts";
import {
  apiThinkingLevels,
  assertXaiChatThinkingSupported,
  defaultApiThinkingLevel,
  isValidIsoCalendarDateSuffix,
  normalizeGoogleModelId,
  requireApiThinkingLevel,
  requireGoogleRequiredThinkingLevel,
  requireLegacyThinkingLevel,
  requireOpenAiProThinkingLevel,
  requiresGoogleThinking,
  requiresXaiChatThinking,
  resolveOpenAiProThinkingLevels,
  supportsGoogleXhighThinking,
  UnsupportedThinkingLevelError,
  type ApiThinkingLevel,
  type ThinkingLevel,
} from "./thinking-levels.ts";
import {
  isRootDefinitionReference,
  JSON_SCHEMA_REF_ISSUE_REASONS,
  type JsonSchemaRefIssue,
} from "../tool-runtime/json-schema-refs.ts";

export type { ThinkingLevel } from "./thinking-levels.ts";
export { UnsupportedThinkingLevelError };
export { shouldRetainEmptyReasoningPart };
export type UnifiedReasoning = NonNullable<LanguageModelV4CallOptions["reasoning"]>;
type GoogleThinkingConfig = NonNullable<GoogleGenerativeAIProviderOptions["thinkingConfig"]>;

const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 16384 } as const;
// Same model family boundaries as the installed OpenAI Responses adapter.
const GPT_MODEL_ID = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/u;
const XAI_GROK_420_PREFIX = "grok-4.20";
const XAI_MULTI_AGENT_MARKER = "-multi-agent";
const GEMINI_25_PRO_MIN_THINKING_BUDGET = 128;
const GEMINI_PRE_3_MODEL_PATTERN = /^gemini-(?:[12](?:[.-]|$)|pro(?:-vision)?$)/;
const GEMINI_FLASH_VERSION_PATTERN = /^gemini-(\d+)\.(\d+)-flash(?:$|-(?!lite(?:-|$)))/;

function supportsOpenAINoneReasoningEffort(modelName: string): boolean {
  if (resolveOpenAiProThinkingLevels(modelName) !== undefined) {
    return false;
  }
  const gpt = GPT_MODEL_ID.exec(modelName);
  if (gpt === null) {
    return false;
  }
  if (gpt[3] !== undefined && /(?:^|-)pro(?:-|$)/u.test(gpt[3])) {
    return false;
  }
  return Number(gpt[1]) > 5 || (Number(gpt[1]) === 5 && Number(gpt[2]) >= 1);
}

export function isOpenAIReasoningModel(modelName: string): boolean {
  if (/^o\d+(?:-|$)/u.test(modelName)) return true;
  const gpt = GPT_MODEL_ID.exec(modelName);
  return (
    gpt !== null && Number(gpt[1]) >= 5 && !(gpt[2] === undefined && gpt[3]?.startsWith("chat"))
  );
}

function supportsAnthropicAdaptiveThinking(modelName: string): boolean {
  const match = /^claude-[a-z]+-(\d+)(?:-(\d+))?(?:\b|-)/.exec(modelName);
  const majorText = match?.[1];
  if (!majorText) {
    return false;
  }

  const major = Number(majorText);
  const minorText = match?.[2];
  const minor = minorText !== undefined && minorText.length <= 2 ? Number(minorText) : 0;
  return major > 4 || (major === 4 && minor >= 6);
}

function isXaiNonReasoningModel(modelName: string): boolean {
  return modelName === "grok-3" || modelName === "grok-4-1" || modelName.includes("-non-reasoning");
}

function isXaiFixedGrok420Model(modelName: string): boolean {
  return modelName.startsWith(XAI_GROK_420_PREFIX) && !modelName.includes(XAI_MULTI_AGENT_MARKER);
}

function isXaiRequiredReasoningModel(modelName: string): boolean {
  return (
    requiresXaiChatThinking(modelName) ||
    modelName.includes(XAI_MULTI_AGENT_MARKER) ||
    (isXaiFixedGrok420Model(modelName) && !isXaiNonReasoningModel(modelName))
  );
}

function isGemini3OrLater(modelName: string): boolean {
  const name = normalizeGoogleModelId(modelName);
  return name.startsWith("gemini-") && !GEMINI_PRE_3_MODEL_PATTERN.test(name);
}

function minimalGemini3ThinkingLevel(modelName: string): "minimal" | "low" {
  const name = normalizeGoogleModelId(modelName);
  if (name === "gemini-flash-latest") {
    return "low";
  }
  const match = GEMINI_FLASH_VERSION_PATTERN.exec(name);
  const majorText = match?.[1];
  const minorText = match?.[2];
  if (!majorText || !minorText) {
    return "minimal";
  }
  const major = Number(majorText);
  const minor = Number(minorText);
  return major > 3 || (major === 3 && minor >= 7) ? "low" : "minimal";
}

function isGemini25Pro(modelName: string): boolean {
  return normalizeGoogleModelId(modelName).includes("gemini-2.5-pro");
}

function googleThinkingConfig(
  modelName: string,
  requestedLevel: ThinkingLevel,
): GoogleThinkingConfig {
  if (requiresGoogleThinking(modelName)) {
    return {
      thinkingLevel: requireGoogleRequiredThinkingLevel(requestedLevel, modelName),
      includeThoughts: true,
    };
  }
  const level = requireLegacyThinkingLevel(requestedLevel, "google");
  if (isGemini3OrLater(modelName)) {
    return level === "off"
      ? { thinkingLevel: minimalGemini3ThinkingLevel(modelName) }
      : { thinkingLevel: level, includeThoughts: true };
  }
  if (level === "off") {
    return { thinkingBudget: isGemini25Pro(modelName) ? GEMINI_25_PRO_MIN_THINKING_BUDGET : 0 };
  }
  return { thinkingBudget: THINKING_BUDGETS[level], includeThoughts: true };
}

export function thinkingProviderOptions(
  providerName: string,
  modelName: string,
  requestedLevel: ThinkingLevel,
): SharedV4ProviderOptions | undefined {
  if (providerName === "google") {
    return { google: { thinkingConfig: googleThinkingConfig(modelName, requestedLevel) } };
  }
  if (providerName === "openai") {
    const proLevels = resolveOpenAiProThinkingLevels(modelName);
    if (proLevels !== undefined) {
      const proLevel = requireOpenAiProThinkingLevel(requestedLevel, modelName, proLevels);
      return { openai: { reasoningEffort: proLevel } };
    }
  }
  const level = requireLegacyThinkingLevel(requestedLevel, providerName);
  if (providerName === "openai") {
    if (level === "off") {
      return supportsOpenAINoneReasoningEffort(modelName)
        ? { openai: { reasoningEffort: "none" } }
        : undefined;
    }
    return { openai: { reasoningEffort: level } };
  }
  if (providerName === "anthropic") {
    if (level === "off") {
      return { anthropic: { thinking: { type: "disabled" } } };
    }
    if (supportsAnthropicAdaptiveThinking(modelName)) {
      return {
        anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: level },
      };
    }
    return { anthropic: { thinking: { type: "enabled", budgetTokens: THINKING_BUDGETS[level] } } };
  }
  if (providerName === "qwen") {
    return level === "off"
      ? { alibaba: { enableThinking: false } }
      : { alibaba: { enableThinking: true, thinkingBudget: THINKING_BUDGETS[level] } };
  }
  if (providerName === "xai") {
    if (isXaiNonReasoningModel(modelName)) {
      return undefined;
    }
    if (isXaiFixedGrok420Model(modelName)) return undefined;
    assertXaiChatThinkingSupported(modelName, level);
    return { xai: { reasoningEffort: level === "off" ? "none" : level } };
  }
  if (providerName === "deepseek") {
    return { deepseek: { thinking: { type: level === "off" ? "disabled" : "enabled" } } };
  }
  return undefined;
}

const OPENAI_KNOWN_STANDARD_REASONING_PATTERN =
  /^(?:o(?:1|3|4)(?:-(?:mini|pro|preview))?|gpt-(?:5(?:\.\d+)?|6(?:\.\d+)?)(?:-(?:mini|nano|codex|preview))?)(?:-(\d{4})-(\d{2})-(\d{2}))?$/u;
const OPENAI_KNOWN_NON_REASONING_PATTERN =
  /^gpt-(?:3\.5-turbo|4(?:\.\d+|o|-turbo)?|5-chat)(?:-(?:mini|nano|preview|latest))?(?:-(\d{4})-(\d{2})-(\d{2}))?$/u;

function isKnownOpenAiStandardReasoningModel(modelName: string): boolean {
  const match = OPENAI_KNOWN_STANDARD_REASONING_PATTERN.exec(modelName);
  return match !== null && isValidIsoCalendarDateSuffix(match[1], match[2], match[3]);
}

function isKnownOpenAiNonReasoningModel(modelName: string): boolean {
  const match = OPENAI_KNOWN_NON_REASONING_PATTERN.exec(modelName);
  return match !== null && isValidIsoCalendarDateSuffix(match[1], match[2], match[3]);
}
const ANTHROPIC_THINKING_MODEL_PATTERN =
  /^claude-(?:3-7-sonnet|(?:sonnet|opus|haiku|fable|mythos)-[4-9](?:-\d+)?)(?:-(?:latest|\d{8}))?$/u;
const ANTHROPIC_LEGACY_NON_THINKING_PATTERN =
  /^claude-(?:2(?:\.\d+)?|3-(?:5-)?(?:opus|sonnet|haiku))(?:-(?:latest|\d{8}))?$/u;
const QWEN_THINKING_MODEL_PATTERN =
  /^qwen(?:3(?:\.\d+)?-(?:plus|max|turbo|flash|coder(?:-plus|-flash)?|vl-(?:plus|max))|-(?:plus|max|turbo|flash))(?:-(?:latest|\d{4}-\d{2}-\d{2}))?$/iu;
const DEEPSEEK_TOGGLE_MODEL_PATTERN =
  /^deepseek-(?:chat|reasoner|flash|r1|v3(?:\.\d+)?|v4(?:\.\d+)?)(?:-(?:flash|lite|chat|reasoner|preview|latest|\d{4,8}))*$/iu;
const GEMINI_25_PRO_CAPABILITY_PATTERN = /^gemini-2\.5-pro(?:-|$)/u;
const GEMINI_25_FLASH_CAPABILITY_PATTERN = /^gemini-2\.5-flash(?:-|$)/u;
const GEMINI_3_KNOWN_CAPABILITY_PATTERN =
  /^gemini-(?:3(?:\.\d+)?-(?:pro|flash)(?:-|$)|(?:pro|flash)-latest$)/u;
const GEMINI_FIXED_NON_THINKING_PATTERN =
  /^gemini-(?:1(?:\.\d+)?|2\.0)-(?:pro|flash|ultra|nano)(?:-|$)/u;
const XAI_KNOWN_FIXED_NON_REASONING_PATTERN =
  /^grok-(?:3|4(?:\.\d+)?)-[a-z0-9.-]*non-reasoning(?:-|$)/u;
const XAI_KNOWN_MULTI_AGENT_PATTERN = /^grok-4(?:\.\d+)?-[a-z0-9.-]*multi-agent(?:-|$)/u;
const XAI_KNOWN_TOGGLEABLE_REASONING_PATTERN =
  /^(?:grok-3-mini(?:-(?:fast|beta))?|grok-4(?:\.3|-(?:fast-)?reasoning)?)(?:-\d{4})?$/u;

/**
 * Resolves the public per-thread effort capability for an API provider/model pair.
 * Only positively matched model families with verified multi-level or toggle semantics
 * are advertised; fixed-reasoning models return `fixed` and unrecognized custom IDs return `unknown`.
 */
export function resolveThreadEffortCapability(
  providerName: string,
  modelName: string,
): ThreadEffortCapability {
  const trimmed = modelName.trim();
  if (trimmed.length === 0) {
    return { kind: "unknown" };
  }
  if (providerName === "google") {
    const normalized = normalizeGoogleModelId(trimmed);
    if (supportsGoogleXhighThinking(trimmed)) {
      return { kind: "levels", levels: ["low", "medium", "high", "xhigh"] };
    }
    if (requiresGoogleThinking(trimmed) || GEMINI_25_PRO_CAPABILITY_PATTERN.test(normalized)) {
      return { kind: "levels", levels: ["low", "medium", "high"] };
    }
    if (
      GEMINI_25_FLASH_CAPABILITY_PATTERN.test(normalized) ||
      GEMINI_3_KNOWN_CAPABILITY_PATTERN.test(normalized)
    ) {
      return { kind: "levels", levels: ["off", "low", "medium", "high"] };
    }
    if (GEMINI_FIXED_NON_THINKING_PATTERN.test(normalized)) {
      return { kind: "fixed" };
    }
    return { kind: "unknown" };
  }
  if (providerName === "deepseek") {
    if (DEEPSEEK_TOGGLE_MODEL_PATTERN.test(trimmed)) {
      return { kind: "toggle", offLevel: "off", onLevel: "medium" };
    }
    return { kind: "unknown" };
  }
  if (providerName === "xai") {
    if (
      trimmed === "grok-3" ||
      trimmed === "grok-4-1" ||
      XAI_KNOWN_FIXED_NON_REASONING_PATTERN.test(trimmed) ||
      (trimmed.startsWith("grok-4.20") &&
        (trimmed === "grok-4.20" || trimmed.startsWith("grok-4.20-")) &&
        !XAI_KNOWN_MULTI_AGENT_PATTERN.test(trimmed))
    ) {
      return { kind: "fixed" };
    }
    if (requiresXaiChatThinking(trimmed) || XAI_KNOWN_MULTI_AGENT_PATTERN.test(trimmed)) {
      return { kind: "levels", levels: ["low", "medium", "high"] };
    }
    if (XAI_KNOWN_TOGGLEABLE_REASONING_PATTERN.test(trimmed)) {
      return { kind: "levels", levels: ["off", "low", "medium", "high"] };
    }
    return { kind: "unknown" };
  }
  if (providerName === "openai") {
    const proLevels = resolveOpenAiProThinkingLevels(trimmed);
    if (proLevels !== undefined) {
      return proLevels.length >= 2 ? { kind: "levels", levels: [...proLevels] } : { kind: "fixed" };
    }
    if (isKnownOpenAiStandardReasoningModel(trimmed) && isOpenAIReasoningModel(trimmed)) {
      return supportsOpenAINoneReasoningEffort(trimmed)
        ? { kind: "levels", levels: ["off", "low", "medium", "high"] }
        : { kind: "levels", levels: ["low", "medium", "high"] };
    }
    if (isKnownOpenAiNonReasoningModel(trimmed)) {
      return { kind: "fixed" };
    }
    return { kind: "unknown" };
  }
  if (providerName === "anthropic") {
    if (ANTHROPIC_THINKING_MODEL_PATTERN.test(trimmed)) {
      return { kind: "levels", levels: ["off", "low", "medium", "high"] };
    }
    if (ANTHROPIC_LEGACY_NON_THINKING_PATTERN.test(trimmed)) {
      return { kind: "fixed" };
    }
    return { kind: "unknown" };
  }
  if (providerName === "qwen") {
    if (QWEN_THINKING_MODEL_PATTERN.test(trimmed)) {
      return { kind: "levels", levels: ["off", "low", "medium", "high"] };
    }
    return { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/** A fixed model may ignore effort entirely or require a single concrete wire value. */
export function resolveFixedThreadEffort(
  capability: ThreadEffortCapability,
  providerName: string,
  modelName: string,
): ThinkingLevel | undefined {
  if (capability.kind !== "fixed") return undefined;
  const levels = apiThinkingLevels(providerName, modelName);
  return levels.length === 1 ? levels[0] : undefined;
}

/**
 * Resolves the effective effort when a thread selects `{ mode: "default" }`.
 * Fixed-effort and unknown models cannot accept user-chosen explicit tiers, so an
 * incompatible global default (such as Gemini 4 `xhigh` or `off` on always-reasoning
 * `grok-4.20`) falls back to `"medium"` instead of making those models unreachable.
 */
export function resolveDefaultThreadEffort(
  capability: ThreadEffortCapability,
  providerName: string,
  modelName: string,
  configuredDefault: ThinkingLevel,
  baseURL?: string,
): ThinkingLevel {
  if (capability.kind === "fixed") {
    const single = resolveFixedThreadEffort(capability, providerName, modelName);
    if (single !== undefined) {
      return single;
    }
    try {
      resolveChatOrSamplingProviderOptions(providerName, modelName, baseURL, configuredDefault);
      validateStructuredOutputThinkingLevel(providerName, modelName, configuredDefault);
      return configuredDefault;
    } catch {
      return "medium";
    }
  }
  if (capability.kind === "unknown") {
    try {
      resolveChatOrSamplingProviderOptions(providerName, modelName, baseURL, configuredDefault);
      return configuredDefault;
    } catch {
      return "medium";
    }
  }
  return configuredDefault;
}

export function isExplicitThreadEffortSupported(
  capability: ThreadEffortCapability,
  providerName: string,
  modelName: string,
  level: ThinkingLevel,
): boolean {
  if (capability.kind === "fixed") {
    return level === resolveFixedThreadEffort(capability, providerName, modelName);
  }
  if (capability.kind === "unknown") return false;
  if (capability.kind === "levels") {
    return capability.levels.includes(level);
  }
  try {
    thinkingProviderOptions(providerName, modelName, level);
    return true;
  } catch {
    return false;
  }
}

export function validateStructuredOutputThinkingLevel(
  providerName: string,
  modelName: string,
  requestedLevel: ThinkingLevel,
): UnifiedReasoning | undefined {
  const thinkingLevel = requireApiThinkingLevel(requestedLevel, providerName, modelName);
  if (providerName === "qwen") {
    return undefined;
  }
  return resolveStructuredOutputReasoning(providerName, modelName, thinkingLevel);
}

export function resolveChatOrSamplingProviderOptions(
  providerName: string,
  modelName: string,
  baseURL: string | undefined,
  requestedLevel: ThinkingLevel,
): SharedV4ProviderOptions | undefined {
  const thinkingLevel = requireApiThinkingLevel(requestedLevel, providerName, modelName);
  const providerOptions = thinkingProviderOptions(providerName, modelName, thinkingLevel);
  if (providerName === "openai" && baseURL) {
    return {
      ...(providerOptions ?? {}),
      openai: {
        ...(providerOptions?.openai ?? {}),
        // OpenAI-compatible endpoints do not always persist Responses output items.
        // Replay full history instead of sending item_reference IDs on later turns.
        store: false,
      },
    };
  }
  return providerOptions;
}

/** Provider 工厂接收的配置 */
interface ProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
}

/**
 * Provider 工厂函数类型。
 * AI SDK v7 中所有 v4 provider 统一返回 LanguageModelV4，
 * 它是 LanguageModel union 的成员，可直接传给 generateText。
 */
type ProviderFactory = (modelName: string, options: ProviderOptions) => LanguageModelV4;

/** Qwen（通义千问）DashScope 兼容 API 地址 */
const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** 已注册的 Provider 工厂 */
const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  anthropic: (modelName, { apiKey, baseURL }) => {
    const provider = createAnthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    return wrapLanguageModel({
      model: provider(modelName),
      middleware: {
        transformParams: async ({ params }) => {
          const prompt = omitForeignEmptyAssistantTextParts(params.prompt, "anthropic");
          const hasStrict =
            params.tools?.some((tool) => tool.type === "function" && tool.strict === true) ?? false;
          if (prompt === params.prompt && !hasStrict) return params;
          return {
            ...params,
            ...(prompt === params.prompt ? {} : { prompt }),
            ...(hasStrict && params.tools !== undefined
              ? {
                  tools: params.tools.map((tool) =>
                    tool.type === "function" && tool.strict === true
                      ? { ...tool, inputSchema: projectAnthropicStrictToolSchema(tool.inputSchema) }
                      : tool,
                  ),
                }
              : {}),
          };
        },
      },
    });
  },
  openai: (modelName, { apiKey, baseURL }) => {
    const provider = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    return wrapLanguageModel({
      model: provider(modelName),
      middleware: {
        transformParams: async ({ params }) => {
          const prompt = omitForeignEmptyAssistantTextParts(params.prompt, "openai");
          const tools = applyOpenAiResponsesToolStrictDefaults(params.tools);
          const toolsChanged = tools !== undefined && tools !== params.tools;
          if (prompt === params.prompt && !toolsChanged) return params;
          return {
            ...params,
            ...(prompt === params.prompt ? {} : { prompt }),
            ...(toolsChanged ? { tools } : {}),
          };
        },
      },
    });
  },
  deepseek: (modelName, { apiKey, baseURL }) => {
    const provider = createDeepSeek({ apiKey, ...(baseURL ? { baseURL } : {}) });
    const model = provider(modelName);
    const isBeta = baseURL?.replace(/\/$/u, "").endsWith("/beta") ?? false;
    // DeepSeek only accepts provider-side strict tool generation on /beta.
    // Keep the original schemas and AI SDK input validation; adapt only the
    // generation hint sent to standard endpoints, for both chat and sampling,
    // while omitting foreign empty signature carriers on both standard and /beta endpoints.
    return wrapLanguageModel({
      model,
      middleware: {
        transformParams: async ({ params }) => {
          const prompt = omitForeignEmptyAssistantTextParts(params.prompt, "deepseek");
          const adaptStrict =
            !isBeta &&
            (params.tools?.some((tool) => tool.type === "function" && tool.strict === true) ??
              false);
          if (prompt === params.prompt && !adaptStrict) return params;
          return {
            ...params,
            ...(prompt === params.prompt ? {} : { prompt }),
            ...(adaptStrict && params.tools !== undefined
              ? {
                  tools: params.tools.map((tool) =>
                    tool.type === "function" && tool.strict === true
                      ? { ...tool, strict: false }
                      : tool,
                  ),
                }
              : {}),
          };
        },
      },
    });
  },
  qwen: (modelName, { apiKey, baseURL }) => {
    const provider = createAlibaba({ apiKey, baseURL: baseURL ?? QWEN_BASE_URL });
    return wrapLanguageModel({
      model: provider(modelName),
      middleware: {
        transformParams: async ({ params }) => {
          const prompt = omitForeignEmptyAssistantTextParts(params.prompt, "alibaba");
          return prompt === params.prompt ? params : { ...params, prompt };
        },
      },
    });
  },
  xai: (modelName, { apiKey, baseURL }) => {
    const provider = createXai({ apiKey, ...(baseURL ? { baseURL } : {}) });
    return wrapLanguageModel({
      model: provider(modelName),
      middleware: {
        transformParams: async ({ params }) => {
          const prompt = omitForeignEmptyAssistantTextParts(params.prompt, "xai");
          return prompt === params.prompt ? params : { ...params, prompt };
        },
      },
    });
  },
  google: (modelName, { apiKey, baseURL }) => {
    const provider = createGoogle({ apiKey, ...(baseURL ? { baseURL } : {}) });
    return wrapLanguageModel({
      model: provider(modelName),
      middleware: {
        transformParams: async ({ params }) => {
          const prompt = omitForeignEmptyAssistantTextParts(params.prompt, "google");
          return prompt === params.prompt ? params : { ...params, prompt };
        },
      },
    });
  },
};

/**
 * 根据 provider 名称创建 AI SDK LanguageModel 实例。
 *
 * 支持: anthropic, openai, deepseek, qwen, xai, google
 */
export function createProviderModel(
  providerName: string,
  modelName: string,
  apiKey: string,
  baseURL?: string,
): LanguageModelV4 {
  const factory = PROVIDER_FACTORIES[providerName];

  if (!factory) {
    const available = Object.keys(PROVIDER_FACTORIES).join(", ");
    throw new Error(`Unknown LLM provider "${providerName}". Supported: ${available}`);
  }

  return factory(modelName, { apiKey, baseURL });
}

/** generateText 调用目的 */
export type LLMCallPurpose = "structured-output" | "text" | "sampling" | "chat";

/** resolveLLMCall 的返回值 */
export interface ResolvedLLMCall {
  readonly model: LanguageModelV4;
  readonly reasoning?: UnifiedReasoning;
  readonly providerOptions?: SharedV4ProviderOptions;
}

function unifiedReasoningForThinkingLevel(level: ApiThinkingLevel): UnifiedReasoning {
  return level === "off" ? "none" : level;
}

function resolveStructuredOutputReasoning(
  providerName: string,
  modelName: string,
  level: ApiThinkingLevel,
): UnifiedReasoning | undefined {
  if (providerName === "openai") {
    if (!isOpenAIReasoningModel(modelName)) {
      return undefined;
    }
    if (level !== "off") {
      return unifiedReasoningForThinkingLevel(level);
    }
    if (supportsOpenAINoneReasoningEffort(modelName)) {
      return "none";
    }
    throw new Error(
      `OpenAI model "${modelName}" cannot disable reasoning for structured output; set runtime.compaction.thinking-level to low or higher`,
    );
  }
  if (providerName === "xai") {
    if (isXaiNonReasoningModel(modelName)) {
      return undefined;
    }
    if (level === "off" && isXaiRequiredReasoningModel(modelName)) {
      throw new UnsupportedThinkingLevelError(
        `模型 ${modelName} 不支持关闭思考。请将 runtime.compaction.thinking-level 设为 low 或更高。`,
      );
    }
    if (isXaiFixedGrok420Model(modelName)) return undefined;
  }
  if (providerName === "google" && level === "off" && isGemini25Pro(modelName)) {
    throw new Error(
      `Google model "${modelName}" cannot disable reasoning for structured output; set runtime.compaction.thinking-level to low or higher`,
    );
  }
  return unifiedReasoningForThinkingLevel(level);
}

/**
 * 把 resolveLLMCall(..., "sampling", ...) 的结果转换成
 * McpClientManager.connect() 需要的 samplingModel/samplingProviderOptions 字段。
 * 统一入口，避免每个调用方（ask/run/chat）各自拼一份、漏传 providerOptions。
 */
export function toSamplingConnectOptions(call: ResolvedLLMCall | undefined): {
  readonly samplingModel?: LanguageModelV4;
  readonly samplingProviderOptions?: SharedV4ProviderOptions;
} {
  if (!call) {
    return {};
  }
  return {
    samplingModel: call.model,
    ...(call.providerOptions ? { samplingProviderOptions: call.providerOptions } : {}),
  };
}

/**
 * 按 provider + 调用目的解析 generateText 的完整调用上下文。
 *
 * structured-output 场景优先使用 AI SDK 顶层 reasoning 统一语义；qwen 是例外，
 * 因为阿里云 thinking mode 不支持 structured output，必须通过 providerOptions 强制关闭。
 *
 * chat 与 sampling 场景下都是纯文本 generateText 调用，复用同一套
 * thinkingProviderOptions 映射注入 reasoning/thinking effort。
 * 显式 baseURL 的 OpenAI Responses 调用使用无服务端状态的历史重放，
 * 避免兼容端点返回 item ID 却未持久化 item 时导致后续轮次失败。
 */
export function resolveLLMCall(
  providerName: string,
  modelName: string,
  apiKey: string,
  purpose: LLMCallPurpose,
  baseURL?: string,
  requestedLevel?: ThinkingLevel,
): ResolvedLLMCall {
  const thinkingLevel = requireApiThinkingLevel(
    requestedLevel ?? defaultApiThinkingLevel(providerName, modelName),
    providerName,
    modelName,
  );
  const model = createProviderModel(providerName, modelName, apiKey, baseURL);

  if (purpose === "structured-output") {
    if (providerName === "qwen") {
      return {
        model,
        providerOptions: { alibaba: { enableThinking: false } },
      };
    }
    const reasoning = resolveStructuredOutputReasoning(providerName, modelName, thinkingLevel);
    return reasoning ? { model, reasoning } : { model };
  }

  if (purpose === "chat" || purpose === "sampling") {
    const providerOptions = resolveChatOrSamplingProviderOptions(
      providerName,
      modelName,
      baseURL,
      thinkingLevel,
    );
    return providerOptions ? { model, providerOptions } : { model };
  }

  return { model };
}

const PROVIDERS_CONVERTING_TOOL_SCHEMAS: ReadonlySet<string> = new Set(["google"]);

export function providerAcceptsToolSchemaIssues(
  providerName: string,
  issues: readonly JsonSchemaRefIssue[],
): boolean {
  if (!PROVIDERS_CONVERTING_TOOL_SCHEMAS.has(providerName)) {
    return true;
  }
  return issues.every(
    (issue) =>
      issue.reason === JSON_SCHEMA_REF_ISSUE_REASONS.recursive &&
      isRootDefinitionReference(issue.ref),
  );
}
