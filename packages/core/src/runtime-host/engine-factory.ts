import type { ChildProcess } from "node:child_process";
import type { EngineModelSwitch } from "@roll-agent/runtime";
import { runtimeSettingsSchema, type RuntimeSettings } from "@roll-agent/runtime/host-contracts";
import { createScheduleToolBinding } from "../scheduler-host/schedule-tool-binding.ts";
import { inspectLlmConfigReadiness, type LlmConfigReadiness } from "../config/helpers.ts";
import type { RollConfig } from "../config/schema.ts";
import { providerAcceptsToolSchemaIssues, resolveLLMCall } from "../llm/providers.ts";
import { CoreAgentHost } from "./agent-host.ts";
import { isDebugLogEnabled, log } from "../cli/utils/output.ts";

export type RuntimeModule = typeof import("@roll-agent/runtime");

export function createToolPolicy(runtime: RuntimeModule, config: RollConfig) {
  return new runtime.ConfigurableToolPolicy({
    defaultMode: config.runtime.approval.default,
    overrides: config.runtime.approval.overrides,
  });
}

export type ThreadStoreInstance = InstanceType<RuntimeModule["ThreadStore"]>;
export type ConversationEngineInstance = InstanceType<RuntimeModule["ConversationEngine"]>;
export type ChatEngineOptions = ConstructorParameters<RuntimeModule["ConversationEngine"]>[0];

export const CHAT_ENGINE_SURFACES = {
  ink: "ink",
  basicRepl: "basic-repl",
  oneShot: "one-shot",
  json: "json",
  server: "server",
  background: "background",
} as const;

export type ChatEngineSurface = (typeof CHAT_ENGINE_SURFACES)[keyof typeof CHAT_ENGINE_SURFACES];

const CHAT_HOST_MODE_BY_SURFACE = {
  [CHAT_ENGINE_SURFACES.ink]: "interactive",
  [CHAT_ENGINE_SURFACES.basicRepl]: "interactive",
  [CHAT_ENGINE_SURFACES.oneShot]: "one-shot",
  [CHAT_ENGINE_SURFACES.json]: "one-shot",
  [CHAT_ENGINE_SURFACES.server]: "server",
  [CHAT_ENGINE_SURFACES.background]: "background",
} as const satisfies Record<ChatEngineSurface, NonNullable<ChatEngineOptions["hostMode"]>>;

export function chatHostModeForSurface(
  surface: ChatEngineSurface,
): NonNullable<ChatEngineOptions["hostMode"]> {
  return CHAT_HOST_MODE_BY_SURFACE[surface];
}

export interface CreateChatEngineInput {
  readonly runtime: RuntimeModule;
  readonly config: RollConfig;
  readonly model: NonNullable<ChatEngineOptions["model"]>;
  readonly store: ThreadStoreInstance;
  readonly surface: ChatEngineSurface;
  readonly modelRecovery?: NonNullable<ChatEngineOptions["modelRecovery"]>;
  readonly policy?: NonNullable<ChatEngineOptions["policy"]>;
  readonly resolveDynamicCapabilityContext?: NonNullable<
    ChatEngineOptions["resolveDynamicCapabilityContext"]
  >;
  readonly providerOptions?: NonNullable<ChatEngineOptions["providerOptions"]>;
  readonly structuredOutputProviderOptions?: NonNullable<
    ChatEngineOptions["structuredOutputProviderOptions"]
  >;
  readonly structuredOutputReasoning?: NonNullable<ChatEngineOptions["structuredOutputReasoning"]>;
  readonly modelCatalog?: NonNullable<ChatEngineOptions["modelCatalog"]>;
  readonly shellEnv?: NodeJS.ProcessEnv;
  readonly onShellCommandSpawn?: (child: ChildProcess) => void;
}

function reportAgentBootstrapIssue(issue: {
  readonly agentName: string;
  readonly message: string;
}): void {
  log.warn(`Agent "${issue.agentName}" 启动失败：${issue.message}`);
}

function reportSkillLibraryIssue(message: string): void {
  log.warn(`skill 目录加载警告：${message}`);
}

function reportWorkspaceInstructionsIssue(message: string): void {
  log.warn(`工作区约定：${message}`);
}

export function createChatEngine(input: CreateChatEngineInput) {
  const provider = input.config.runtime.provider ?? input.config.llm.defaultProvider;
  return new input.runtime.ConversationEngine({
    settings: mapRuntimeSettings(input.config),
    provider,
    modelName: input.config.runtime.model ?? input.config.llm.defaultModel,
    model: input.model,
    toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(provider, issues),
    agentHost: new CoreAgentHost({
      config: input.config,
      onAgentBootstrapIssue: reportAgentBootstrapIssue,
      onSkillLibraryIssue: reportSkillLibraryIssue,
    }),
    store: input.store,
    hostMode: chatHostModeForSurface(input.surface),
    policy: input.policy ?? createToolPolicy(input.runtime, input.config),
    maxSteps: input.config.runtime.maxSteps,
    ...(chatHostModeForSurface(input.surface) === "interactive" && input.modelRecovery
      ? { modelRecovery: input.modelRecovery }
      : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    ...(input.structuredOutputProviderOptions
      ? { structuredOutputProviderOptions: input.structuredOutputProviderOptions }
      : {}),
    ...(input.structuredOutputReasoning
      ? { structuredOutputReasoning: input.structuredOutputReasoning }
      : {}),
    ...(input.resolveDynamicCapabilityContext
      ? { resolveDynamicCapabilityContext: input.resolveDynamicCapabilityContext }
      : {}),
    ...(input.modelCatalog ? { modelCatalog: input.modelCatalog } : {}),
    scheduleTools: createScheduleToolBinding(),
    debugEvents: isDebugLogEnabled(),
    onAgentBootstrapIssue: reportAgentBootstrapIssue,
    onWorkspaceInstructionsIssue: reportWorkspaceInstructionsIssue,
    ...(input.shellEnv ? { shellEnv: input.shellEnv } : {}),
    ...(input.onShellCommandSpawn ? { onShellCommandSpawn: input.onShellCommandSpawn } : {}),
  });
}

/** Explicitly project execution settings; credentials and discovery configuration stay in Core. */
export function mapRuntimeSettings(config: RollConfig): RuntimeSettings {
  return runtimeSettingsSchema.parse({
    maxSteps: config.runtime.maxSteps,
    turnTimeoutMs: config.runtime.turnTimeoutMs,
    ...(config.runtime.contextWindow === undefined
      ? {}
      : { contextWindow: config.runtime.contextWindow }),
    compaction: config.runtime.compaction,
    shell: config.runtime.shell,
    instructions: config.chat.instructions,
  });
}

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

export async function loadRuntime(): Promise<RuntimeModule> {
  return import("@roll-agent/runtime");
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
