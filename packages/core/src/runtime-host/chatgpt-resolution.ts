import { wrapLanguageModel } from "ai";
import { ChatGptConnection } from "./chatgpt-connection.ts";
import { createChatGptTurnRecovery } from "./chatgpt-turn-recovery.ts";
import { ChatGptAuthError } from "../auth/chatgpt/errors.ts";
import type { EngineModelSwitch } from "@roll-agent/runtime";
import type { RollConfig } from "../config/schema.ts";
import { getChatGptAuthService } from "../auth/chatgpt/service.ts";
import { createChatGptModel } from "../llm/chatgpt-model.ts";
import { assertChatGptFastModeSupported, withChatGptFastMode } from "../llm/chatgpt-fast-mode.ts";
import { providerAcceptsToolSchemaIssues } from "../llm/providers.ts";
import { chatGptThinkingLevels } from "../llm/thinking-levels.ts";
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
> &
  Partial<Pick<ReturnType<typeof getChatGptAuthService>, "cachedModels">>;
export type ChatGptModels = Awaited<ReturnType<ChatGptAuth["models"]>>;
/** Also passed as a whole EngineModelSwitch during reconnect/window synchronization. */
export type InteractiveChatLlm = ReturnType<typeof resolveChatLlmCalls> & {
  readonly provider: string;
  readonly modelName: string;
  readonly accountId?: string;
  readonly models?: ChatGptModels;
  readonly connection?: ChatGptConnection;
  readonly modelRecovery?: NonNullable<EngineModelSwitch["modelRecovery"]>;
};

/** Subscription identity/model resolution is async; API-key resolvers remain synchronous. */
export async function resolveInteractiveChatLlm(
  config: RollConfig,
  options: {
    readonly accountId?: string;
    readonly selectModel?: (models: ChatGptModels) => Promise<string | undefined>;
    readonly auth?: ChatGptAuth;
    readonly deferConnection?: boolean;
    readonly enableRecovery?: boolean;
    readonly connection?: ChatGptConnection;
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
  if (options.deferConnection) {
    const models =
      options.connection?.models ?? (accountId ? (auth.cachedModels?.(accountId) ?? []) : []);
    const modelName = config.runtime.model ?? "未选择 ChatGPT 模型";
    const connection = options.connection ?? new ChatGptConnection(auth, accountId, models);
    const effortOptions = (level: RollConfig["runtime"]["thinkingLevel"]) =>
      withChatGptFastMode(
        { openai: { reasoningEffort: level === "off" ? "none" : level } },
        config.runtime.fastMode,
      );
    const model = wrapLanguageModel({
      model: createChatGptModel({
        modelId: modelName,
        getAccessToken: (signal) => connection.getAccessToken(signal),
        onNetworkError: (error) => connection.failed(error),
      }),
      middleware: {
        specificationVersion: "v4",
        transformParams: async ({ params }) => {
          await connection.ensure(params.abortSignal);
          const live = connection.models.find(({ slug }) => slug === modelName);
          if (!live) {
            throw new ChatGptAuthError(
              "model_unavailable",
              `当前账号不提供模型 "${modelName}"；请使用 /model 选择可用模型，会话和输入已保留。`,
            );
          }
          assertChatGptFastModeSupported(
            params.providerOptions?.openai?.serviceTier === "priority",
            live,
          );
          const effort = params.providerOptions?.openai?.reasoningEffort;
          const allowed = chatGptThinkingLevels(live).map((level) =>
            level === "off" ? "none" : level,
          );
          if (typeof effort === "string" && !allowed.some((value) => value === effort)) {
            throw new ChatGptAuthError(
              "unsupported_effort",
              `当前模型不支持推理强度 "${effort}"；请使用 /effort 或调整压缩推理强度，会话和输入已保留。`,
            );
          }
          return params;
        },
      },
    });
    return {
      provider,
      modelName,
      toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(provider, issues),
      ...(accountId ? { accountId } : {}),
      models,
      connection,
      ...(options.enableRecovery ? { modelRecovery: createChatGptTurnRecovery(connection) } : {}),
      model,
      providerOptions: effortOptions(config.runtime.thinkingLevel),
      structuredOutputProviderOptions: effortOptions(
        config.runtime.compaction.thinkingLevel ?? config.runtime.thinkingLevel,
      ),
    };
  }
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
  assertChatGptFastModeSupported(config.runtime.fastMode, selectedModel);
  if (options.enableRecovery) {
    // Startup model selection and deferred startup share live model/effort authorization,
    // including after recovery refreshes the catalog. Noninteractive resolution is unchanged.
    chatGptThinkingOptions(config.runtime.thinkingLevel, selectedModel);
    chatGptThinkingOptions(
      config.runtime.compaction.thinkingLevel ?? config.runtime.thinkingLevel,
      selectedModel,
    );
    return resolveInteractiveChatLlm(
      { ...config, runtime: { ...config.runtime, model: modelName } },
      {
        auth,
        accountId,
        connection: options.connection ?? new ChatGptConnection(auth, accountId, models),
        deferConnection: true,
        enableRecovery: true,
      },
    );
  }
  return {
    provider,
    modelName,
    toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(provider, issues),
    accountId,
    models,
    model: createChatGptModel({
      modelId: modelName,
      getAccessToken: (signal) => auth.getAccessToken(accountId, signal),
    }),
    providerOptions: withChatGptFastMode(
      chatGptThinkingOptions(config.runtime.thinkingLevel, selectedModel),
      config.runtime.fastMode,
    ),
    structuredOutputProviderOptions: withChatGptFastMode(
      chatGptThinkingOptions(
        config.runtime.compaction.thinkingLevel ?? config.runtime.thinkingLevel,
        selectedModel,
      ),
      config.runtime.fastMode,
    ),
  };
}

export function chatGptThinkingOptions(
  level: RollConfig["runtime"]["thinkingLevel"],
  model?: ChatGptModels[number],
) {
  const effort = level === "off" ? "none" : level;
  const levels = chatGptThinkingLevels(model);
  if (!levels.includes(level)) {
    throw new Error(
      `ChatGPT 模型 "${model?.slug ?? "未知"}" 不支持推理强度 "${level}"。支持的档位：${levels.join(", ") || "无可用档位"}；请使用 /effort 查看选项，或修改 runtime.thinkingLevel / runtime.compaction.thinkingLevel。`,
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
  connection?: ChatGptConnection,
): Promise<EngineModelSwitch> {
  if (choice.provider !== "chatgpt") return resolveChatLlmSwitch(config, choice, thinkingLevel);
  const resolution = await resolveInteractiveChatLlm(
    {
      ...config,
      runtime: { ...config.runtime, provider: choice.provider, model: choice.model, thinkingLevel },
    },
    {
      ...(accountId !== undefined ? { accountId } : {}),
      ...(auth ? { auth } : {}),
      ...(connection ? { connection, deferConnection: true, enableRecovery: true } : {}),
    },
  );
  return {
    provider: resolution.provider,
    modelName: resolution.modelName,
    model: resolution.model,
    toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(resolution.provider, issues),
    ...(resolution.modelRecovery ? { modelRecovery: resolution.modelRecovery } : {}),
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
