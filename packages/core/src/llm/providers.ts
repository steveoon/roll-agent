import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

/**
 * Provider 工厂函数类型。
 * AI SDK v6 中所有 v3 provider 统一返回 LanguageModelV3，
 * 它是 LanguageModel union 的成员，可直接传给 generateText / generateObject。
 */
type ProviderFactory = (modelName: string, apiKey: string) => LanguageModelV3;

/** Qwen（通义千问）DashScope OpenAI 兼容 API 地址 */
const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** 已注册的 Provider 工厂 */
const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  anthropic: (modelName, apiKey) => {
    const provider = createAnthropic({ apiKey });
    return provider(modelName);
  },
  openai: (modelName, apiKey) => {
    const provider = createOpenAI({ apiKey });
    return provider(modelName);
  },
  qwen: (modelName, apiKey) => {
    const provider = createOpenAI({ apiKey, baseURL: QWEN_BASE_URL });
    return provider(modelName);
  },
};

/**
 * 根据 provider 名称创建 AI SDK LanguageModel 实例。
 *
 * 支持: anthropic, openai, qwen
 */
export function createProviderModel(
  providerName: string,
  modelName: string,
  apiKey: string,
): LanguageModelV3 {
  const factory = PROVIDER_FACTORIES[providerName];

  if (!factory) {
    const available = Object.keys(PROVIDER_FACTORIES).join(", ");
    throw new Error(`Unknown LLM provider "${providerName}". Supported: ${available}`);
  }

  return factory(modelName, apiKey);
}
