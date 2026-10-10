import type { EngineModelSwitch } from "@roll-agent/runtime";
import type { RollConfig } from "../config/schema.ts";
import { getChatGptAuthService } from "../auth/chatgpt/service.ts";
import { createChatGptModel } from "../llm/chatgpt-model.ts";
import type { LlmModelChoice } from "../llm/model-choices.ts";
import { listLlmModelChoices } from "../llm/model-choices.ts";
import type { SessionPickerItem } from "../cli/chat/session-picker-format.ts";
import { buildModelPickerItems } from "../cli/chat/model-picker-format.ts";
import {
  resolveChatLlmReadiness,
  resolveChatLlmCalls,
  resolveChatLlmSwitch,
} from "./engine-factory.ts";

export type ChatGptAuth = Pick<
  ReturnType<typeof getChatGptAuthService>,
  "status" | "models" | "getAccessToken"
>;
export type ChatGptModels = Awaited<ReturnType<ChatGptAuth["models"]>>;
export type InteractiveChatLlm = ReturnType<typeof resolveChatLlmCalls> & {
  readonly provider: string;
  readonly modelName: string;
  readonly accountId?: string;
  readonly models?: ChatGptModels;
};

/** Subscription identity/model resolution is async; API-key resolvers remain synchronous. */
export async function resolveInteractiveChatLlm(
  config: RollConfig,
  options: {
    readonly accountId?: string;
    readonly selectModel?: (models: ChatGptModels) => Promise<string | undefined>;
    readonly auth?: ChatGptAuth;
  } = {},
): Promise<InteractiveChatLlm> {
  const provider = config.runtime.provider ?? config.llm.defaultProvider;
  if (provider !== "chatgpt") {
    const ready = resolveChatLlmReadiness(config);
    if (!ready.configured || !ready.providerConfig) throw new Error(ready.message);
    return {
      provider: ready.provider,
      modelName: ready.model,
      ...resolveChatLlmCalls(
        ready.provider,
        ready.model,
        ready.providerConfig.apiKey,
        ready.providerConfig.baseUrl,
        config.runtime.thinkingLevel,
        config.runtime.compaction.thinkingLevel,
        config.runtime.compaction.strategy === "summarize",
      ),
    };
  }
  const auth = options.auth ?? getChatGptAuthService();
  const status = await auth.status();
  const accountId = options.accountId ?? config.runtime.chatgptAccountId ?? status.currentAccountId;
  if (!accountId) throw new Error("请先运行 roll auth chatgpt login，再选择订阅模型。");
  const models = await auth.models(accountId);
  const modelName = config.runtime.model ?? (await options.selectModel?.(models));
  if (!modelName) {
    throw new Error(
      "请选择 ChatGPT 订阅模型：roll auth chatgpt models，然后使用 roll chat --provider chatgpt --model <slug>，或保存 runtime.model。",
    );
  }
  const selectedModel = models.find((model) => model.slug === modelName);
  if (!selectedModel) {
    throw new Error(
      `当前 ChatGPT 账号不提供模型 "${modelName}"。请运行 roll auth chatgpt models --account ${accountId} 后重新选择。`,
    );
  }
  return {
    provider,
    modelName,
    accountId,
    models,
    model: createChatGptModel({
      modelId: modelName,
      getAccessToken: () => auth.getAccessToken(accountId),
    }),
    providerOptions: chatGptThinkingOptions(config.runtime.thinkingLevel, selectedModel),
    structuredOutputProviderOptions: chatGptThinkingOptions(
      config.runtime.compaction.thinkingLevel ?? config.runtime.thinkingLevel,
      selectedModel,
    ),
  };
}

export function chatGptThinkingOptions(
  level: RollConfig["runtime"]["thinkingLevel"],
  model?: ChatGptModels[number],
) {
  const effort = level === "off" ? "none" : level;
  if (model?.reasoningEfforts && !model.reasoningEfforts.includes(effort)) {
    throw new Error(
      `ChatGPT 模型 "${model.slug}" 不支持推理强度 "${level}"。支持的档位：${model.reasoningEfforts.join(", ")}；请使用 /effort low 或修改 runtime.thinkingLevel / runtime.compaction.thinkingLevel。`,
    );
  }
  return { openai: { reasoningEffort: effort } };
}

export async function resolveInteractiveChatSwitch(
  config: RollConfig,
  choice: Pick<LlmModelChoice, "provider" | "model">,
  thinkingLevel: RollConfig["runtime"]["thinkingLevel"],
  accountId?: string,
  auth?: ChatGptAuth,
): Promise<EngineModelSwitch> {
  if (choice.provider !== "chatgpt") return resolveChatLlmSwitch(config, choice, thinkingLevel);
  const resolution = await resolveInteractiveChatLlm(
    {
      ...config,
      runtime: { ...config.runtime, provider: choice.provider, model: choice.model, thinkingLevel },
    },
    { ...(accountId !== undefined ? { accountId } : {}), ...(auth ? { auth } : {}) },
  );
  return {
    provider: resolution.provider,
    modelName: resolution.modelName,
    model: resolution.model,
    ...(resolution.providerOptions ? { providerOptions: resolution.providerOptions } : {}),
    ...(resolution.structuredOutputProviderOptions
      ? { structuredOutputProviderOptions: resolution.structuredOutputProviderOptions }
      : {}),
  };
}

/** These choices belong to one registration, never the shared static catalog. */
export function chatGptModelChoices(models: ChatGptModels): readonly LlmModelChoice[] {
  return models.map(({ slug }) => ({
    id: `chatgpt/${slug}`,
    provider: "chatgpt",
    model: slug,
    origin: "configured",
  }));
}

export function chatModelPickerItems(
  config: RollConfig,
  models: ChatGptModels,
  current: string,
): readonly SessionPickerItem[] {
  return [
    ...buildModelPickerItems(listLlmModelChoices(config), current),
    ...models.map(({ slug, displayName }) => ({
      id: `chatgpt/${slug}`,
      title: displayName,
      meta: `ChatGPT 订阅 · ${slug}${current === slug ? " · 当前" : ""}`,
    })),
  ];
}

/** Pin the catalog owner so a later login cannot change a picker selection's identity. */
export async function loadAuthenticatedChatGptModels(
  auth: ChatGptAuth,
  preferredAccountId?: string,
): Promise<{ readonly accountId?: string; readonly models: ChatGptModels }> {
  const status = await auth.status();
  const account = status.accounts.find(
    ({ id }) => id === (preferredAccountId ?? status.currentAccountId),
  );
  if (!account?.connected || !account.authorized) return { models: [] };
  return { accountId: account.id, models: await auth.models(account.id) };
}
