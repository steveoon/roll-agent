import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

/** Provider 工厂函数类型 */
type ProviderFactory = (modelName: string, apiKey: string) => LanguageModel;

/** 已注册的 Provider 工厂 */
const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  anthropic: (modelName, apiKey) => {
    const provider = createAnthropic({ apiKey });
    return provider(modelName);
  },
};

/**
 * 根据 provider 名称创建 AI SDK LanguageModel 实例。
 *
 * 当前支持: anthropic
 * Phase 2 将添加: qwen, openai
 */
export function createProviderModel(
  providerName: string,
  modelName: string,
  apiKey: string,
): LanguageModel {
  const factory = PROVIDER_FACTORIES[providerName];

  if (!factory) {
    const available = Object.keys(PROVIDER_FACTORIES).join(", ");
    throw new Error(`Unknown LLM provider "${providerName}". Supported: ${available}`);
  }

  return factory(modelName, apiKey);
}
