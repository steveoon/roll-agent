import { generateText } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createProviderModel } from "./providers.ts";
import type { RollConfig } from "../config/schema.ts";

/** LLM Engine 选项 */
export interface LLMEngineOptions {
  /** 覆盖默认 provider */
  readonly provider?: string;
  /** 覆盖默认 model */
  readonly model?: string;
}

/** LLM Engine — 统一多 Provider 的文本生成接口 */
export class LLMEngine {
  private readonly config: RollConfig;

  constructor(config: RollConfig) {
    this.config = config;
  }

  /**
   * 生成文本（非流式）。
   *
   * 使用 AI SDK v7 的 generateText，支持 Anthropic provider。
   */
  async generateText(prompt: string, options: LLMEngineOptions = {}): Promise<string> {
    const model = this.resolveModel(options);
    const result = await generateText({ model, prompt });
    return result.text;
  }

  /** 解析 provider + model，创建 AI SDK LanguageModel 实例 */
  private resolveModel(options: LLMEngineOptions): LanguageModelV4 {
    const providerName = options.provider ?? this.config.llm.defaultProvider;
    const modelName = options.model ?? this.config.llm.defaultModel;
    const providerConfig = this.config.llm.providers[providerName];

    if (!providerConfig) {
      throw new Error(
        `LLM provider "${providerName}" not configured. ` +
          `Available: ${Object.keys(this.config.llm.providers).join(", ") || "(none)"}`,
      );
    }

    return createProviderModel(
      providerName,
      modelName,
      providerConfig.apiKey,
      providerConfig.baseUrl,
    );
  }
}
