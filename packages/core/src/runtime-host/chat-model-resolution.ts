import type {
  EngineModelSwitch,
  ConversationEngineOptions as ChatEngineOptions,
} from "@roll-agent/runtime";
import type { RollConfig } from "../config/schema.ts";
import { inspectLlmConfigReadiness, type LlmConfigReadiness } from "../config/helpers.ts";
import { providerAcceptsToolSchemaIssues, resolveLLMCall } from "../llm/providers.ts";

export function resolveChatLlmSwitch(
  config: RollConfig,
  choice: { readonly provider: string; readonly model: string },
  thinkingLevel: RollConfig["runtime"]["thinkingLevel"],
): EngineModelSwitch {
  if (choice.provider === "chatgpt") {
    throw new Error(
      "ChatGPT 订阅模型切换仅支持普通 roll chat；Runtime 服务和 Companion 暂不支持。",
    );
  }
  const readiness = inspectLlmConfigReadiness(config, choice);
  if (!readiness.configured || !readiness.providerConfig) {
    throw new Error(readiness.message);
  }
  const calls = resolveChatLlmCalls(
    choice.provider,
    choice.model,
    readiness.providerConfig.apiKey,
    readiness.providerConfig.baseUrl,
    thinkingLevel,
    config.runtime.compaction.thinkingLevel,
    config.runtime.compaction.strategy === "summarize",
  );
  return {
    provider: choice.provider,
    modelName: choice.model,
    toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(choice.provider, issues),
    model: calls.model,
    ...(calls.providerOptions ? { providerOptions: calls.providerOptions } : {}),
    ...(calls.structuredOutputProviderOptions
      ? { structuredOutputProviderOptions: calls.structuredOutputProviderOptions }
      : {}),
    ...(calls.structuredOutputReasoning
      ? { structuredOutputReasoning: calls.structuredOutputReasoning }
      : {}),
  };
}

export function resolveChatLlmReadiness(config: RollConfig): LlmConfigReadiness {
  if ((config.runtime.provider ?? config.llm.defaultProvider) === "chatgpt") {
    return {
      configured: false,
      status: "missing-provider",
      provider: "chatgpt",
      model: config.runtime.model ?? "",
      summary: "ChatGPT 订阅（实验）",
      message:
        "ChatGPT 订阅支持 roll chat 和 scheduler；暂不支持 Runtime 服务或 Companion。请为这些入口选择 API Key provider。",
    };
  }
  return inspectLlmConfigReadiness(config, {
    provider: config.runtime.provider ?? config.llm.defaultProvider,
    model: config.runtime.model ?? config.llm.defaultModel,
  });
}

export function resolveChatLlmCalls(
  provider: string,
  modelName: string,
  apiKey: string,
  baseUrl: string | undefined,
  thinkingLevel: RollConfig["runtime"]["thinkingLevel"],
  compactionThinkingLevel: RollConfig["runtime"]["compaction"]["thinkingLevel"] = undefined,
  compactionUsesStructuredOutput = true,
): {
  readonly model: NonNullable<ChatEngineOptions["model"]>;
  readonly toolSchemaPolicy: NonNullable<ChatEngineOptions["toolSchemaPolicy"]>;
  readonly providerOptions?: NonNullable<ChatEngineOptions["providerOptions"]>;
  readonly structuredOutputProviderOptions?: NonNullable<
    ChatEngineOptions["structuredOutputProviderOptions"]
  >;
  readonly structuredOutputReasoning?: NonNullable<ChatEngineOptions["structuredOutputReasoning"]>;
} {
  const chat = resolveLLMCall(provider, modelName, apiKey, "chat", baseUrl, thinkingLevel);
  const structuredOutput = compactionUsesStructuredOutput
    ? resolveLLMCall(
        provider,
        modelName,
        apiKey,
        "structured-output",
        baseUrl,
        compactionThinkingLevel ?? thinkingLevel,
      )
    : undefined;
  return {
    model: chat.model,
    toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(provider, issues),
    ...(chat.providerOptions ? { providerOptions: chat.providerOptions } : {}),
    ...(structuredOutput?.providerOptions
      ? { structuredOutputProviderOptions: structuredOutput.providerOptions }
      : {}),
    ...(structuredOutput?.reasoning
      ? { structuredOutputReasoning: structuredOutput.reasoning }
      : {}),
  };
}
