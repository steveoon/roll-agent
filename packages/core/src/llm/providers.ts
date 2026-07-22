import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createXai } from "@ai-sdk/xai";
import { runtimeThinkingLevels } from "../config/schema.ts";

export type ThinkingLevel = (typeof runtimeThinkingLevels)[number];
export type UnifiedReasoning = NonNullable<LanguageModelV4CallOptions["reasoning"]>;

const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 16384 } as const;
const OPENAI_NONE_REASONING_PREFIXES = [
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.3",
  "gpt-5.4",
  "gpt-5.5",
] as const;
const OPENAI_REASONING_MODEL_PREFIXES = ["o1", "o3", "o4-mini"] as const;
const XAI_GROK_420_PREFIX = "grok-4.20";
const XAI_MULTI_AGENT_MARKER = "-multi-agent";

function supportsOpenAINoneReasoningEffort(modelName: string): boolean {
  return OPENAI_NONE_REASONING_PREFIXES.some((prefix) => modelName.startsWith(prefix));
}

function isOpenAIReasoningModel(modelName: string): boolean {
  return (
    OPENAI_REASONING_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix)) ||
    (modelName.startsWith("gpt-5") && !modelName.startsWith("gpt-5-chat"))
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

function supportsXaiReasoningEffort(modelName: string): boolean {
  return !isXaiFixedGrok420Model(modelName);
}

function isXaiFixedGrok420Model(modelName: string): boolean {
  return modelName.startsWith(XAI_GROK_420_PREFIX) && !modelName.includes(XAI_MULTI_AGENT_MARKER);
}

function isXaiRequiredReasoningModel(modelName: string): boolean {
  return (
    modelName === "grok-4.5" ||
    modelName.includes(XAI_MULTI_AGENT_MARKER) ||
    (isXaiFixedGrok420Model(modelName) && !isXaiNonReasoningModel(modelName))
  );
}

export function thinkingProviderOptions(
  providerName: string,
  modelName: string,
  level: ThinkingLevel,
): SharedV4ProviderOptions | undefined {
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
      return { anthropic: { thinking: { type: "adaptive" }, effort: level } };
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
    if (!supportsXaiReasoningEffort(modelName)) {
      return level === "off" ? undefined : { xai: { reasoningSummary: "auto" } };
    }
    return level === "off"
      ? { xai: { reasoningEffort: "none" } }
      : { xai: { reasoningEffort: level, reasoningSummary: "auto" } };
  }
  if (providerName === "deepseek") {
    return { deepseek: { thinking: { type: level === "off" ? "disabled" : "enabled" } } };
  }
  return undefined;
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
    return provider(modelName);
  },
  openai: (modelName, { apiKey, baseURL }) => {
    const provider = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    return provider(modelName);
  },
  deepseek: (modelName, { apiKey, baseURL }) => {
    const provider = createDeepSeek({ apiKey, ...(baseURL ? { baseURL } : {}) });
    return provider(modelName);
  },
  qwen: (modelName, { apiKey, baseURL }) => {
    const provider = createAlibaba({ apiKey, baseURL: baseURL ?? QWEN_BASE_URL });
    return provider(modelName);
  },
  xai: (modelName, { apiKey, baseURL }) => {
    const provider = createXai({ apiKey, ...(baseURL ? { baseURL } : {}) });
    return provider(modelName);
  },
};

/**
 * 根据 provider 名称创建 AI SDK LanguageModel 实例。
 *
 * 支持: anthropic, openai, deepseek, qwen, xai
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

function unifiedReasoningForThinkingLevel(level: ThinkingLevel): UnifiedReasoning {
  return level === "off" ? "none" : level;
}

function resolveStructuredOutputReasoning(
  providerName: string,
  modelName: string,
  level: ThinkingLevel,
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
    if (isXaiFixedGrok420Model(modelName)) {
      if (level === "off") {
        throw new Error(
          `xAI model "${modelName}" cannot disable reasoning for structured output; set runtime.compaction.thinking-level to low or higher`,
        );
      }
      return undefined;
    }
    if (level === "off" && isXaiRequiredReasoningModel(modelName)) {
      throw new Error(
        `xAI model "${modelName}" cannot disable reasoning for structured output; set runtime.compaction.thinking-level to low or higher`,
      );
    }
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
  thinkingLevel: ThinkingLevel = "medium",
): ResolvedLLMCall {
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
    const providerOptions = thinkingProviderOptions(providerName, modelName, thinkingLevel);
    if (providerName === "openai" && baseURL) {
      return {
        model,
        providerOptions: {
          ...(providerOptions ?? {}),
          openai: {
            ...(providerOptions?.openai ?? {}),
            // OpenAI-compatible endpoints do not always persist Responses output items.
            // Replay full history instead of sending item_reference IDs on later turns.
            store: false,
          },
        },
      };
    }
    return providerOptions ? { model, providerOptions } : { model };
  }

  return { model };
}
