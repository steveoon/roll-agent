import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { runtimeThinkingLevels } from "../config/schema.ts";

export type ThinkingLevel = (typeof runtimeThinkingLevels)[number];

const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 16384 } as const;
const OPENAI_NONE_REASONING_PREFIXES = ["gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4"] as const;

function supportsOpenAINoneReasoningEffort(modelName: string): boolean {
  return OPENAI_NONE_REASONING_PREFIXES.some((prefix) => modelName.startsWith(prefix));
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
};

/**
 * 根据 provider 名称创建 AI SDK LanguageModel 实例。
 *
 * 支持: anthropic, openai, deepseek, qwen
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
  readonly providerOptions?: SharedV4ProviderOptions;
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
 * structured-output 场景下，对 qwen provider 自动注入 enableThinking: false，
 * 因为阿里云 thinking mode 不支持 structured output。
 *
 * chat 与 sampling 场景下都是纯文本 generateText 调用，复用同一套
 * thinkingProviderOptions 映射注入 reasoning/thinking effort。
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

  if (purpose === "structured-output" && providerName === "qwen") {
    return {
      model,
      providerOptions: { alibaba: { enableThinking: false } },
    };
  }

  if (purpose === "chat" || purpose === "sampling") {
    const providerOptions = thinkingProviderOptions(providerName, modelName, thinkingLevel);
    return providerOptions ? { model, providerOptions } : { model };
  }

  return { model };
}
