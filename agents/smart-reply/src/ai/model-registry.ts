import { createAnthropic } from "@ai-sdk/anthropic";
import { createProviderRegistry } from "ai";
import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderConfig } from "../types/classification.ts";

// ========== Model Dictionary ==========

export type ModelCategory = "chat" | "general";

export const MODEL_DICTIONARY = {
  "qwen/qwen-max-latest": {
    provider: "qwen",
    name: "Qwen Max Latest",
    categories: ["general"] as ModelCategory[],
  },
  "qwen/qwen-plus-latest": {
    provider: "qwen",
    name: "Qwen Plus Latest",
    categories: ["general"] as ModelCategory[],
  },
  "google/gemini-embedding-2-preview": {
    provider: "google",
    name: "Gemini Embedding 2 Preview",
    categories: ["general"] as ModelCategory[],
  },
  "google/gemini-3.1-flash-lite-preview": {
    provider: "google",
    name: "Gemini 3.1 Flash Lite Preview",
    categories: ["general", "chat"] as ModelCategory[],
  },
  "google/gemini-3.1-pro-preview": {
    provider: "google",
    name: "Gemini 3.1 Pro Preview",
    categories: ["chat", "general"] as ModelCategory[],
  },
  "anthropic/claude-sonnet-4-6": {
    provider: "anthropic",
    name: "Claude Sonnet 4.6",
    categories: ["chat", "general"] as ModelCategory[],
  },
  "anthropic/claude-opus-4-6": {
    provider: "anthropic",
    name: "Claude Opus 4.6",
    categories: ["chat", "general"] as ModelCategory[],
  },
  "anthropic/claude-haiku-4-5": {
    provider: "anthropic",
    name: "Claude Haiku 4.5",
    categories: ["chat", "general"] as ModelCategory[],
  },
  "openai/gpt-5.1": {
    provider: "openai",
    name: "GPT-5.1",
    categories: ["chat", "general"] as ModelCategory[],
  },
  "openai/gpt-5.2": {
    provider: "openai",
    name: "GPT-5.2",
    categories: ["general"] as ModelCategory[],
  },
  "openai/gpt-5.4": {
    provider: "openai",
    name: "GPT-5.4",
    categories: ["chat", "general"] as ModelCategory[],
  },
  "openai/gpt-5-mini": {
    provider: "openai",
    name: "GPT-5 Mini",
    categories: ["general"] as ModelCategory[],
  },
  "ohmygpt/gemini-3.1-flash-lite-preview": {
    provider: "ohmygpt",
    name: "Gemini 3.1 Flash Lite Preview (OhMyGPT)",
    categories: ["general"] as ModelCategory[],
  },
  "ohmygpt/gemini-3.1-pro-preview": {
    provider: "ohmygpt",
    name: "Gemini 3.1 Pro Preview (OhMyGPT)",
    categories: ["general"] as ModelCategory[],
  },
  "moonshotai/kimi-k2.5": {
    provider: "moonshotai",
    name: "Kimi K2.5",
    categories: ["chat", "general"] as ModelCategory[],
  },
  "moonshotai/kimi-k2-thinking-turbo": {
    provider: "moonshotai",
    name: "Kimi K2 Thinking Turbo",
    categories: ["chat", "general"] as ModelCategory[],
  },
  "deepseek/deepseek-chat": {
    provider: "deepseek",
    name: "DeepSeek Chat",
    categories: ["chat", "general"] as ModelCategory[],
  },
} as const;

export type ModelId = keyof typeof MODEL_DICTIONARY;

// ========== Default Configs ==========

export const DEFAULT_PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  anthropic: {
    name: "Anthropic",
    baseURL: "https://apic1.ohmycdn.com/v1",
    description: "Anthropic Claude",
  },
  openai: {
    name: "OpenAI",
    baseURL: "https://apic1.ohmycdn.com/v1",
    description: "OpenAI GPT",
  },
  ohmygpt: {
    name: "OhMyGPT",
    baseURL: "https://apic1.ohmycdn.com/v1",
    description: "OhMyGPT",
  },
  moonshotai: {
    name: "MoonshotAI",
    baseURL: "https://api.moonshot.cn/v1",
    description: "MoonshotAI",
  },
  deepseek: { name: "DeepSeek", baseURL: "https://api.deepseek.com", description: "DeepSeek" },
  qwen: {
    name: "Qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    description: "Qwen",
  },
  google: {
    name: "Google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    description: "Google Gemini",
  },
};

export const DEFAULT_MODEL_CONFIG = {
  chatModel: "anthropic/claude-haiku-4-5" as ModelId,
  classifyModel:
    (process.env.SMART_REPLY_CLASSIFY_MODEL as ModelId) || ("openai/gpt-5-mini" as ModelId),
  replyModel:
    (process.env.SMART_REPLY_REPLY_MODEL as ModelId) || ("openai/gpt-5.4" as ModelId),
} as const;

function getSharedProxyApiKey(): string {
  // 当前统一代理对 Anthropic/OpenAI/OhMyGPT 走同一套鉴权。
  // 为兼容仓库里仍存在的 OPENAI_API_KEY 示例，回退读取 OPENAI_API_KEY。
  return process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || "";
}

// ========== Custom Provider Factories ==========

function createCustomOpenAI(config: { apiKey: string | undefined; baseURL?: string | undefined }) {
  const openaiInstance = createOpenAI({
    apiKey: config.apiKey || "",
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
  });
  return new Proxy(openaiInstance, {
    get(_target, prop) {
      if (prop === "languageModel") {
        return (modelId: string) => openaiInstance.chat(modelId);
      }
      if (prop === "chat" || prop === "completion") {
        return openaiInstance[prop as keyof typeof openaiInstance];
      }
      if (prop === "embeddingModel" || prop === "imageModel") {
        const method = openaiInstance[prop as keyof typeof openaiInstance];
        return method || undefined;
      }
      return openaiInstance[prop as keyof typeof openaiInstance];
    },
  });
}

// ========== Dynamic Registry ==========

function createDynamicRegistry(providerConfigs: Record<string, ProviderConfig>) {
  const sharedProxyApiKey = getSharedProxyApiKey();
  return createProviderRegistry(
    {
      anthropic: createAnthropic({
        apiKey: sharedProxyApiKey,
        baseURL: providerConfigs.anthropic?.baseURL || "https://apic1.ohmycdn.com/v1",
      }),
      openai: createCustomOpenAI({
        apiKey: sharedProxyApiKey,
        baseURL: providerConfigs.openai?.baseURL || "https://apic1.ohmycdn.com/v1",
      }),
      ohmygpt: createOpenAICompatible({
        name: "ohmygpt",
        baseURL: providerConfigs.ohmygpt?.baseURL || "https://apic1.ohmycdn.com/v1",
        apiKey: sharedProxyApiKey,
      }),
      moonshotai: createOpenAICompatible({
        name: "moonshotai",
        baseURL: providerConfigs.moonshotai?.baseURL || "https://api.moonshot.cn/v1",
        apiKey: process.env.MOONSHOT_API_KEY || "",
      }),
      deepseek: createDeepSeek({
        baseURL: providerConfigs.deepseek?.baseURL || "https://api.deepseek.com",
        apiKey: process.env.DEEPSEEK_API_KEY || "",
      }),
      google: createGoogleGenerativeAI({
        apiKey: process.env.GEMINI_API_KEY || "",
        baseURL:
          providerConfigs.google?.baseURL || "https://generativelanguage.googleapis.com/v1beta",
      }),
      qwen: createOpenAICompatible({
        name: "qwen",
        apiKey: process.env.DASHSCOPE_API_KEY || "",
        baseURL:
          providerConfigs.qwen?.baseURL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      }),
    },
    { separator: "/" },
  );
}

/** 只暴露 registry 实际被消费的 languageModel 方法，避免 .d.ts 引用内部类型导致 TS2742 */
interface ModelRegistry {
  languageModel(modelId: string): LanguageModel;
}

let cachedRegistry: ModelRegistry | null = null;
let lastConfigHash: string | null = null;

export function getDynamicRegistry(providerConfigs: Record<string, ProviderConfig>): ModelRegistry {
  const configHash = JSON.stringify(providerConfigs);
  if (cachedRegistry && lastConfigHash === configHash) return cachedRegistry;
  cachedRegistry = createDynamicRegistry(providerConfigs);
  lastConfigHash = configHash;
  console.error(
    "[DYNAMIC REGISTRY] 创建新的动态registry，配置哈希:",
    configHash.substring(0, 16) + "...",
  );
  return cachedRegistry;
}
