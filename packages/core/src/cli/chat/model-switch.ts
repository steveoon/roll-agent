import type { AgentSession, EngineModelSwitch } from "@roll-agent/runtime";
import type { RollConfig } from "../../config/schema.ts";
import { withChatGptFastMode } from "../../llm/chatgpt-fast-mode.ts";
import { findLlmModelChoice, listLlmModelChoices } from "../../llm/model-choices.ts";
import { thinkingProviderOptions } from "../../llm/providers.ts";
import {
  apiThinkingLevels,
  chatGptThinkingLevels,
  type ThinkingLevel,
} from "../../llm/thinking-levels.ts";
import {
  chatGptModelChoices,
  chatGptThinkingOptions,
  resolveInteractiveChatSwitch,
  type ChatGptModels,
} from "../../runtime-host/chatgpt-resolution.ts";
import type { ChatGptConnection } from "../../runtime-host/chatgpt-connection.ts";
import type { ChatModelSwitchResult } from "./ink/app.ts";

/** Keep async resolution separate from the synchronous Engine/host-state commit. */
export async function resolveAndSwitchChatModel<T>(options: {
  resolve(): Promise<EngineModelSwitch>;
  getFastMode(): boolean;
  commit(selection: EngineModelSwitch): T;
}): Promise<T> {
  const selection = await options.resolve();
  if (selection.provider !== "chatgpt") return options.commit(selection);

  // Resolution can overlap a Fast change. Rebase both option sets immediately before
  // committing, with no await between the preference read and the Engine/host update.
  const enabled = options.getFastMode();
  return options.commit({
    ...selection,
    providerOptions: withChatGptFastMode(selection.providerOptions, enabled),
    structuredOutputProviderOptions: withChatGptFastMode(
      selection.structuredOutputProviderOptions,
      enabled,
    ),
  });
}

export interface InteractiveChatModelControlOptions {
  readonly config: RollConfig;
  readonly getSession: () => Pick<AgentSession, "setProviderOptions">;
  readonly switchEngineModel: (selection: EngineModelSwitch) =>
    | {
        readonly window: number;
        readonly source: NonNullable<ChatModelSwitchResult["contextWindowSource"]>;
      }
    | undefined;
  readonly getState: () => {
    readonly provider: string;
    readonly model: string;
    readonly thinkingLevel: ThinkingLevel;
    readonly fastMode: boolean;
    readonly selection: EngineModelSwitch;
    readonly subscriptionModels: ChatGptModels;
    readonly subscriptionAccountId: string | undefined;
  };
  readonly setSelection: (next: EngineModelSwitch) => void;
  readonly setThinkingLevel: (next: ThinkingLevel) => void;
  readonly setModelIdentity: (provider: string, model: string) => void;
  readonly refreshSubscriptionModels?: () => Promise<{
    readonly models: ChatGptModels;
    readonly accountId: string | undefined;
  }>;
  readonly connection?: ChatGptConnection;
}

/** Shared `/effort`, `/think` and `/model` control wiring used by fullscreen `roll chat`. */
export function createInteractiveChatModelControls(options: InteractiveChatModelControlOptions) {
  const getCurrentSubscriptionModel = () => {
    const state = options.getState();
    const models = options.connection?.models ?? state.subscriptionModels;
    return models.find(({ slug }) => slug === state.model);
  };

  return {
    getThinkingLevels: (): readonly ThinkingLevel[] => {
      const state = options.getState();
      return state.provider === "chatgpt"
        ? chatGptThinkingLevels(getCurrentSubscriptionModel())
        : apiThinkingLevels(state.provider, state.model);
    },
    onThinkingChange: (level: ThinkingLevel): void => {
      const state = options.getState();
      const nextOptions =
        state.provider === "chatgpt"
          ? withChatGptFastMode(
              chatGptThinkingOptions(level, getCurrentSubscriptionModel()),
              state.fastMode,
            )
          : thinkingProviderOptions(state.provider, state.model, level);
      options.getSession().setProviderOptions(nextOptions);
      options.setSelection({ ...state.selection, providerOptions: nextOptions ?? {} });
      options.setThinkingLevel(level);
    },
    getTargetThinkingLevels: async (input: string): Promise<readonly ThinkingLevel[]> => {
      const state = options.getState();
      const selected = findLlmModelChoice(
        [...listLlmModelChoices(options.config), ...chatGptModelChoices(state.subscriptionModels)],
        input,
      );
      if (selected?.provider !== "chatgpt" && !input.startsWith("chatgpt/")) {
        if (!selected) {
          throw new Error(`未知模型 "${input}"，输入 /model 查看可选项`);
        }
        return apiThinkingLevels(selected.provider, selected.model);
      }
      const refreshed = await options.refreshSubscriptionModels?.();
      const models = refreshed?.models ?? options.getState().subscriptionModels;
      const model = models.find(
        ({ slug }) => `chatgpt/${slug}` === input || slug === selected?.model,
      );
      if (!model) throw new Error(`当前账号不提供模型 "${input}"`);
      return chatGptThinkingLevels(model);
    },
    switchTo: async (
      input: string,
      selectedEffort?: ThinkingLevel,
    ): Promise<ChatModelSwitchResult> => {
      if (input.startsWith("chatgpt/") && options.getState().subscriptionModels.length === 0) {
        await options.refreshSubscriptionModels?.();
      }
      const state = options.getState();
      const choice = findLlmModelChoice(
        [...listLlmModelChoices(options.config), ...chatGptModelChoices(state.subscriptionModels)],
        input,
      );
      if (!choice) {
        throw new Error(`未知模型 "${input}"，输入 /model 查看可选项`);
      }
      return resolveAndSwitchChatModel({
        resolve: () =>
          resolveInteractiveChatSwitch(
            { ...options.config, runtime: { ...options.config.runtime, fastMode: state.fastMode } },
            choice,
            selectedEffort ?? state.thinkingLevel,
            state.subscriptionAccountId,
            undefined,
            options.connection,
          ),
        getFastMode: () => options.getState().fastMode,
        commit: (nextSelection) => {
          const resolution = options.switchEngineModel(nextSelection);
          options.setSelection(nextSelection);
          options.setModelIdentity(choice.provider, choice.model);
          const nextThinkingLevel = selectedEffort ?? options.getState().thinkingLevel;
          options.setThinkingLevel(nextThinkingLevel);
          return {
            thinkingLevel: nextThinkingLevel,
            id: choice.id,
            model: choice.model,
            contextWindow: resolution?.window,
            ...(resolution ? { contextWindowSource: resolution.source } : {}),
          };
        },
      });
    },
  };
}
