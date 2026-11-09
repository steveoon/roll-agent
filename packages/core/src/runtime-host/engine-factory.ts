import type { RuntimeConfigContext } from "../config/runtime-context.ts";
import type { ChildProcess } from "node:child_process";
import type { PreparedThreadModel } from "@roll-agent/runtime";
import { createThreadModelHost, withThreadModelReasoning } from "./thread-model-host.ts";
import { runtimeSettingsSchema, type RuntimeSettings } from "@roll-agent/runtime/host-contracts";
import { createScheduleToolBinding } from "../scheduler-host/schedule-tool-binding.ts";
import type { RollConfig } from "../config/schema.ts";
import { providerAcceptsToolSchemaIssues } from "../llm/providers.ts";
import { CoreAgentHost } from "./agent-host.ts";
import { isDebugLogEnabled, log } from "../cli/utils/output.ts";
import { resolveChatWorkspace } from "./workspace-identity.ts";

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
  readonly configContext?: RuntimeConfigContext;
  readonly runtime: RuntimeModule;
  readonly config: RollConfig;
  readonly model: NonNullable<ChatEngineOptions["model"]>;
  readonly store: ThreadStoreInstance;
  readonly surface: ChatEngineSurface;
  readonly modelRecovery?: NonNullable<ChatEngineOptions["modelRecovery"]>;
  readonly resolveReasoningPresentation?: ChatEngineOptions["resolveReasoningPresentation"];
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
  return new input.runtime.ConversationEngine(chatEngineOptions(input));
}

/** Only the multi-conversation protocol host needs independent MCP Sampling scopes. */
export function createRuntimeChatEngine(input: CreateChatEngineInput) {
  const provider = input.config.runtime.provider ?? input.config.llm.defaultProvider;
  const initial: PreparedThreadModel = withThreadModelReasoning({
    provider,
    modelName: input.config.runtime.model ?? input.config.llm.defaultModel,
    model: input.model,
    toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(provider, issues),
    ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    ...(input.structuredOutputProviderOptions
      ? { structuredOutputProviderOptions: input.structuredOutputProviderOptions }
      : {}),
    ...(input.structuredOutputReasoning
      ? { structuredOutputReasoning: input.structuredOutputReasoning }
      : {}),
  });
  return new input.runtime.ThreadModelEngine({
    initial,
    host: createThreadModelHost(input.config, initial),
    createEngine: (selection, lifecycle) => {
      const {
        modelRecovery: _modelRecovery,
        providerOptions: _providerOptions,
        structuredOutputProviderOptions: _structuredOutputProviderOptions,
        structuredOutputReasoning: _structuredOutputReasoning,
        ...hostOptions
      } = chatEngineOptions(input);
      return new input.runtime.ConversationEngine({
        ...hostOptions,
        ...selection,
        ...lifecycle,
      });
    },
  });
}

function chatEngineOptions(input: CreateChatEngineInput): ChatEngineOptions {
  const provider = input.config.runtime.provider ?? input.config.llm.defaultProvider;
  return {
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
    workspace: resolveChatWorkspace(),
    hostMode: chatHostModeForSurface(input.surface),
    ...(input.resolveReasoningPresentation
      ? { resolveReasoningPresentation: input.resolveReasoningPresentation }
      : {}),
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
    scheduleTools: createScheduleToolBinding(
      input.configContext === undefined ? {} : { configContext: input.configContext },
    ),
    debugEvents: isDebugLogEnabled(),
    onAgentBootstrapIssue: reportAgentBootstrapIssue,
    onWorkspaceInstructionsIssue: reportWorkspaceInstructionsIssue,
    ...(input.shellEnv ? { shellEnv: input.shellEnv } : {}),
    ...(input.onShellCommandSpawn ? { onShellCommandSpawn: input.onShellCommandSpawn } : {}),
  };
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

export async function loadRuntime(): Promise<RuntimeModule> {
  return import("@roll-agent/runtime");
}

export {
  resolveChatLlmSwitch,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
} from "./chat-model-resolution.ts";
