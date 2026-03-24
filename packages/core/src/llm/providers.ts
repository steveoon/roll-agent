import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";

/** Provider 工厂接收的配置 */
interface ProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
}

/**
 * Provider 工厂函数类型。
 * AI SDK v6 中所有 v3 provider 统一返回 LanguageModelV3，
 * 它是 LanguageModel union 的成员，可直接传给 generateText。
 */
type ProviderFactory = (modelName: string, options: ProviderOptions) => LanguageModelV3;

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
): LanguageModelV3 {
  const factory = PROVIDER_FACTORIES[providerName];

  if (!factory) {
    const available = Object.keys(PROVIDER_FACTORIES).join(", ");
    throw new Error(`Unknown LLM provider "${providerName}". Supported: ${available}`);
  }

  return factory(modelName, { apiKey, baseURL });
}
