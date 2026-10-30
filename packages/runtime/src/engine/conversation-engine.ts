import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { SkillLibrary } from "../skills/contracts.ts";
import type {
  AgentHost,
  AgentHostOperation,
  AgentHostSnapshot,
} from "../host-contracts/agent-host.ts";
import type { RuntimeSettings } from "../host-contracts/runtime-settings.ts";
import type { ScheduleToolPort } from "../host-contracts/schedule-tools.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import type { ToolPolicy } from "../types/policy.ts";
import type { ThreadStore, ThreadSnapshot } from "../store/thread-store.ts";
import type { ThreadOrigin } from "../store/thread-origin.ts";
import {
  AgentSession,
  type AgentInstallSessionResult,
  type AgentSessionAgentInstall,
  type AgentSessionBashSession,
  type AgentSessionCapabilityContext,
  type AgentSessionOptions,
  type SessionAgentRefresh,
  type SessionModelSwitch,
  type ToolSchemaPolicy,
} from "./agent-session.ts";
import { resolveModelContextWindow, type ContextWindowResolution } from "./context-window.ts";
import { createDefaultModelCatalog } from "./model-catalog-default.ts";
import type { ModelCatalog } from "./model-catalog.ts";
import {
  createWorkspaceInstructionsSource,
  parseWorkspaceInstructionsSetting,
  type WorkspaceInstructionsSource,
} from "./workspace-instructions.ts";
import {
  CAPABILITY_HOST_MODES,
  shouldOfferAgentInstall,
  shouldOfferScheduleCreate,
  type CapabilityAgentOnboardingCatalogEntry,
  type CapabilityHostMode,
  type CapabilityVcsSnapshot,
} from "./capability-manifest.ts";
import { type SessionBashSettings } from "../tool-bridge/bash-tool.ts";
import {
  type CommandClassifier,
  unknownCommandClassifier,
} from "../types/command-classification.ts";
import {
  resolveShellProfile,
  type ShellProfile,
  type ShellProfileResolutionResult,
} from "../bash/profile.ts";
import { inspectGitVcsContext } from "./vcs-context.ts";
import { createToolLedgerGapRecoveryMessage } from "./cancelled-turn-recovery.ts";

const ENGINE_CLOSING_MESSAGE = "ConversationEngine is closing";
const strictToolSchemaPolicy: ToolSchemaPolicy = (issues) => issues.length === 0;

export interface EngineModelSwitch extends Omit<SessionModelSwitch, "contextWindow"> {
  readonly provider: string;
  readonly modelName: string;
}

export interface ConversationEngineOptions {
  readonly settings: RuntimeSettings;
  readonly provider: string;
  readonly modelName: string;
  readonly model: LanguageModelV4;
  readonly toolSchemaPolicy?: ToolSchemaPolicy;
  readonly agentHost?: AgentHost;
  readonly sources?: readonly AgentToolSource[];
  readonly store?: ThreadStore;
  readonly modelCatalog?: ModelCatalog;
  readonly policy?: ToolPolicy;
  readonly maxSteps?: number;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly modelRecovery?: AgentSessionOptions["modelRecovery"];
  readonly structuredOutputProviderOptions?: SharedV4ProviderOptions;
  readonly structuredOutputReasoning?: NonNullable<LanguageModelV4CallOptions["reasoning"]>;
  readonly debugEvents?: boolean;
  readonly onAgentBootstrapIssue?: (issue: AgentBootstrapIssue) => void;
  readonly skillLibrary?: SkillLibrary | null;
  readonly scheduleTools?: ScheduleToolPort | null;
  readonly workspaceInstructions?: WorkspaceInstructionsSource | null;
  readonly onWorkspaceInstructionsIssue?: (message: string) => void;
  readonly hostMode?: CapabilityHostMode;
  readonly resolveDynamicCapabilityContext?: AgentSessionOptions["resolveDynamicCapabilityContext"];
  readonly sessionExecEnabled?: boolean;
  readonly shellProfile?: ShellProfile | null;
  readonly resolveShellProfileFn?: typeof resolveShellProfile;
  readonly inspectVcsContext?: (
    cwd: string,
  ) => CapabilityVcsSnapshot | undefined | Promise<CapabilityVcsSnapshot | undefined>;
  readonly shellEnv?: NodeJS.ProcessEnv;
  readonly onShellCommandSpawn?: (child: ChildProcess) => void;
  readonly fileToolsEnabled?: boolean;
}

export function buildSessionExecSettings(input: {
  readonly settings: RuntimeSettings;
  readonly profile: ShellProfile;
  readonly env: NodeJS.ProcessEnv;
  readonly onCommandSpawn?: (child: ChildProcess) => void;
}): AgentSessionBashSession {
  const shell = input.settings.shell;
  return {
    workdir: process.cwd(),
    profile: input.profile,
    maxSessions: shell.session.maxSessions,
    defaultYieldMs: shell.session.defaultYieldMs,
    maxOutputTokens: shell.session.maxOutputTokens,
    bufferCapacity: shell.maxCaptureBytes,
    env: input.env,
    ...(input.onCommandSpawn ? { onCommandSpawn: input.onCommandSpawn } : {}),
  };
}

export function buildSessionBashSettings(input: {
  readonly settings: RuntimeSettings;
  readonly profile: ShellProfile;
  readonly env: NodeJS.ProcessEnv;
  readonly onCommandSpawn?: (child: ChildProcess) => void;
}): SessionBashSettings {
  const shell = input.settings.shell;
  return {
    workdir: process.cwd(),
    defaultTimeoutMs: shell.defaultTimeoutMs,
    maxTimeoutMs: shell.maxTimeoutMs,
    turnTimeoutMs: input.settings.turnTimeoutMs,
    maxCaptureBytes: shell.maxCaptureBytes,
    maxModelOutputChars: shell.maxModelOutputChars,
    profile: input.profile,
    env: input.env,
    ...(input.onCommandSpawn ? { onCommandSpawn: input.onCommandSpawn } : {}),
  };
}

export interface CreateSessionInput {
  readonly id?: string;
  readonly title?: string;
  readonly origin?: ThreadOrigin;
}

export interface ForkSessionInput {
  readonly title?: string;
}

export interface AgentBootstrapIssue {
  readonly agentName: string;
  readonly message: string;
}

export interface EngineContextSummary {
  readonly agentCount: number;
  readonly toolCount: number;
  readonly skillCount: number;
  readonly instructionsPath?: string;
}

interface EngineContext {
  readonly model: LanguageModelV4;
  readonly sources: readonly AgentToolSource[];
  readonly skillLibrary?: SkillLibrary;
}

function createEngineClosingError(): Error {
  return new Error(ENGINE_CLOSING_MESSAGE);
}

function resolveWorkspaceInstructionsSource(
  options: ConversationEngineOptions,
): WorkspaceInstructionsSource | undefined {
  if (options.workspaceInstructions === null) {
    return undefined;
  }
  if (options.workspaceInstructions !== undefined) {
    return options.workspaceInstructions;
  }
  const cwd = process.cwd();
  return createWorkspaceInstructionsSource({
    cwd,
    setting: parseWorkspaceInstructionsSetting(options.settings.instructions, cwd),
    ...(options.onWorkspaceInstructionsIssue
      ? { onIssue: options.onWorkspaceInstructionsIssue }
      : {}),
  });
}

export class ConversationEngine {
  private readonly settings: RuntimeSettings;
  private readonly agentHost: AgentHost | undefined;
  private readonly store: ThreadStore | undefined;
  private readonly policy: ToolPolicy | undefined;
  private readonly fileToolsEnabled: boolean;
  private readonly maxSteps: number;
  private providerOptions: SharedV4ProviderOptions | undefined;
  private modelRecovery: AgentSessionOptions["modelRecovery"];
  private modelOverride: LanguageModelV4 | undefined;
  private modelName: string;
  private provider: string;
  private toolSchemaPolicy: ToolSchemaPolicy;
  private switchingProviderName: string | undefined;
  private readonly modelCatalog: ModelCatalog;
  private structuredOutputProviderOptions: SharedV4ProviderOptions | undefined;
  private structuredOutputReasoning:
    | NonNullable<LanguageModelV4CallOptions["reasoning"]>
    | undefined;
  private readonly debugEvents: boolean;
  private readonly explicitModel: LanguageModelV4;
  private readonly explicitSources: readonly AgentToolSource[] | undefined;
  private readonly explicitSkillLibrary: SkillLibrary | null | undefined;
  private readonly workspaceInstructions: WorkspaceInstructionsSource | undefined;
  private readonly onAgentBootstrapIssue: ((issue: AgentBootstrapIssue) => void) | undefined;
  private readonly hostMode: CapabilityHostMode;
  private readonly scheduleTools: ScheduleToolPort | undefined;
  private readonly resolveDynamicCapabilityContext:
    | NonNullable<ConversationEngineOptions["resolveDynamicCapabilityContext"]>
    | undefined;
  private readonly sessionExecEnabled: boolean;
  private readonly explicitShellProfile: ShellProfile | null | undefined;
  private readonly resolveShellProfileFn: typeof resolveShellProfile;
  private readonly inspectVcsContext: NonNullable<ConversationEngineOptions["inspectVcsContext"]>;
  private readonly shellEnv: NodeJS.ProcessEnv;
  private readonly onShellCommandSpawn: ((child: ChildProcess) => void) | undefined;
  private ready: Promise<EngineContext> | undefined;
  private refreshChain: Promise<void> = Promise.resolve();
  private resolvedCatalog: readonly CapabilityAgentOnboardingCatalogEntry[] = [];
  private readonly pendingInstalls = new Set<Promise<AgentInstallSessionResult>>();
  private shellProfileResolution: ShellProfileResolutionResult | undefined;
  private shellUnsupportedWarned = false;
  private readonly liveSessions = new Map<string, AgentSession>();
  private readonly shutdownController = new AbortController();
  private disposePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: ConversationEngineOptions) {
    if (!options.model) throw new Error("ConversationEngine requires a model supplied by its host");
    if (options.agentHost !== undefined && options.sources !== undefined) {
      throw new Error("ConversationEngine accepts either sources or agentHost, not both");
    }
    this.settings = options.settings;
    this.agentHost = options.agentHost;
    this.provider = options.provider;
    this.modelName = options.modelName;
    this.toolSchemaPolicy = options.toolSchemaPolicy ?? strictToolSchemaPolicy;
    this.store = options.store;
    this.modelCatalog = options.modelCatalog ?? createDefaultModelCatalog();
    this.policy = options.policy;
    this.fileToolsEnabled = options.fileToolsEnabled ?? true;
    this.maxSteps = options.maxSteps ?? options.settings.maxSteps;
    this.providerOptions = options.providerOptions;
    this.modelRecovery = options.modelRecovery;
    this.structuredOutputProviderOptions = options.structuredOutputProviderOptions;
    this.structuredOutputReasoning = options.structuredOutputReasoning;
    this.debugEvents = options.debugEvents ?? false;
    this.hostMode = options.hostMode ?? CAPABILITY_HOST_MODES.embedded;
    this.scheduleTools = options.scheduleTools ?? undefined;
    this.resolveDynamicCapabilityContext = options.resolveDynamicCapabilityContext;
    this.sessionExecEnabled = options.sessionExecEnabled ?? true;
    this.explicitShellProfile = options.shellProfile;
    this.resolveShellProfileFn = options.resolveShellProfileFn ?? resolveShellProfile;
    this.explicitModel = options.model;
    this.explicitSources = options.sources;
    this.explicitSkillLibrary = options.skillLibrary;
    this.workspaceInstructions = resolveWorkspaceInstructionsSource(options);
    this.onAgentBootstrapIssue = options.onAgentBootstrapIssue;
    this.inspectVcsContext = options.inspectVcsContext ?? inspectGitVcsContext;
    this.shellEnv = { ...(options.shellEnv ?? process.env) };
    this.onShellCommandSpawn = options.onShellCommandSpawn;
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    this.assertAcceptingSessions();
    const context = await this.ensureReady();
    this.assertAcceptingSessions();
    const id = this.store
      ? this.store.createThread({
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
          ...(input.title ? { title: input.title } : {}),
          model: this.resolveModelName(),
        })
      : (input.id ?? randomUUID());
    return this.buildSession(context, id, []);
  }

  async resumeSession(threadId: string): Promise<AgentSession> {
    this.assertAcceptingSessions();
    if (!this.store) {
      throw new Error("resumeSession requires a ThreadStore");
    }
    if (this.store.getThread(threadId)?.origin.kind === "scheduled") {
      throw new Error("定时执行会话是只读记录；请基于该次运行创建新对话");
    }
    const liveSession = this.liveSessions.get(threadId);
    if (liveSession !== undefined) {
      return liveSession;
    }
    if (!this.store.hasThread(threadId)) {
      throw new Error(`Thread "${threadId}" 不存在`);
    }
    const context = await this.ensureReady();
    this.assertAcceptingSessions();
    const concurrentlyResumedSession = this.liveSessions.get(threadId);
    if (concurrentlyResumedSession !== undefined) {
      return concurrentlyResumedSession;
    }
    this.recoverUncoveredToolExecutionContext(threadId);
    const state = this.store.loadSessionState(threadId);
    return this.buildSession(context, threadId, state.messages, state.checkpoint);
  }

  async forkSession(snapshot: ThreadSnapshot, input: ForkSessionInput = {}): Promise<AgentSession> {
    this.assertAcceptingSessions();
    if (!this.store) throw new Error("forkSession requires a ThreadStore");
    const context = await this.ensureReady();
    this.assertAcceptingSessions();
    const id = this.store.forkSnapshot(snapshot, { ...input, model: this.resolveModelName() });
    try {
      this.recoverUncoveredToolExecutionContext(id);
      const state = this.store.loadSessionState(id);
      return this.buildSession(context, id, state.messages, state.checkpoint);
    } catch (error) {
      this.store.deleteThread(id);
      throw error;
    }
  }

  private assertAcceptingSessions(): void {
    if (this.closing) {
      throw createEngineClosingError();
    }
  }

  private resolveRuntimeShellProfile(): ShellProfile | undefined {
    const shell = this.settings.shell;
    if (!shell.enabled) {
      return undefined;
    }
    if (this.explicitShellProfile !== undefined) {
      return this.explicitShellProfile ?? undefined;
    }
    if (this.shellProfileResolution === undefined) {
      this.shellProfileResolution = this.resolveShellProfileFn({
        platform: process.platform,
        env: this.shellEnv,
      });
    }
    const result = this.shellProfileResolution;
    if (!result.supported) {
      if (!this.shellUnsupportedWarned) {
        this.shellUnsupportedWarned = true;
        const reason =
          result.reason === "pwsh-version-unsupported"
            ? "检测到的 pwsh 版本低于 7"
            : "未检测到 PowerShell 7 (pwsh)";
        process.stderr.write(
          `roll chat: ${reason}，Windows 原生 shell 工具已跳过注册；可运行 winget install Microsoft.PowerShell\n`,
        );
      }
      return undefined;
    }
    return result.profile;
  }

  private resolveShellSettings(profile: ShellProfile): SessionBashSettings {
    return buildSessionBashSettings({
      settings: this.settings,
      profile,
      env: this.shellEnv,
      ...(this.onShellCommandSpawn ? { onCommandSpawn: this.onShellCommandSpawn } : {}),
    });
  }

  private resolveSessionExecSettings(profile: ShellProfile): AgentSessionBashSession | undefined {
    if (!this.sessionExecEnabled) {
      return undefined;
    }
    const shell = this.settings.shell;
    if (!shell.enabled || !shell.session.enabled) {
      return undefined;
    }
    if (!profile.supportsSessionExec) {
      return undefined;
    }
    return buildSessionExecSettings({
      settings: this.settings,
      profile,
      env: this.shellEnv,
      ...(this.onShellCommandSpawn ? { onCommandSpawn: this.onShellCommandSpawn } : {}),
    });
  }

  private buildSession(
    context: EngineContext,
    id: string,
    initialMessages: readonly ModelMessage[],
    initialCheckpoint?: ReturnType<ThreadStore["getLatestCheckpoint"]>,
  ): AgentSession {
    const store = this.store;
    const derivedFrom = store?.getThread(id)?.derivedFrom;
    const contextWindowResolution = this.resolveContextWindowFor(
      this.resolveProviderName(),
      this.resolveModelName(),
    );
    const skills = context.skillLibrary?.list() ?? [];
    const skillLibrary = skills.length > 0 ? context.skillLibrary : undefined;
    const refreshSkills =
      this.explicitSkillLibrary === undefined
        ? this.agentHost?.refreshSkills?.bind(this.agentHost)
        : undefined;
    const shellProfile = this.resolveRuntimeShellProfile();
    const bash = shellProfile ? this.resolveShellSettings(shellProfile) : undefined;
    const fileTools = this.fileToolsEnabled
      ? { workdir: bash?.workdir ?? process.cwd() }
      : undefined;
    const bashSession = shellProfile ? this.resolveSessionExecSettings(shellProfile) : undefined;
    const bashClassifier: CommandClassifier | undefined = shellProfile
      ? shellProfile.supportsSafeCommandClassification && this.settings.shell.autoApproveSafe
        ? shellProfile
        : unknownCommandClassifier
      : undefined;
    const agentInstall = shouldOfferAgentInstall(this.hostMode)
      ? this.resolveAgentInstallBinding()
      : undefined;
    const schedulePort = this.scheduleTools;
    const capabilityContext = this.composeCapabilityContext(context.sources.length, shellProfile);
    const session = new AgentSession({
      id,
      model: this.activeModel(context),
      onBeforeTurn: this.assertModelUpdateIdle,
      ...(this.modelRecovery === undefined ? {} : { modelRecovery: this.modelRecovery }),
      sources: context.sources,
      toolSchemaPolicy: this.toolSchemaPolicy,
      onToolExcluded: (exclusion) =>
        this.onAgentBootstrapIssue?.({
          agentName: exclusion.agentName,
          message: `工具 "${exclusion.toolName}" 的参数 schema 含当前 provider "${this.resolveToolSchemaProviderName()}" 无法接受的引用（${exclusion.issues.map((issue) => issue.ref).join("、")}），已从本会话工具集移除`,
        }),
      capabilityContext,
      resolveDynamicCapabilityContext: async (abortSignal) => {
        const [vcs, dynamic] = await Promise.all([
          this.inspectVcsContext(capabilityContext.cwd),
          this.resolveDynamicCapabilityContext?.(abortSignal) ?? {},
        ]);
        const effectiveVcs = dynamic.vcs ?? vcs;
        return {
          ...(dynamic.ruleIds ? { ruleIds: dynamic.ruleIds } : {}),
          ...(effectiveVcs ? { vcs: effectiveVcs } : {}),
          ...(dynamic.origin ? { origin: dynamic.origin } : {}),
        };
      },
      ...(skillLibrary ? { skillLibrary } : {}),
      ...(refreshSkills
        ? {
            refreshSkillLibrary: (signal: AbortSignal) =>
              refreshSkills({ ...this.hostOperation(), signal }),
          }
        : {}),
      ...(this.workspaceInstructions ? { workspaceInstructions: this.workspaceInstructions } : {}),
      ...(fileTools ? { fileTools } : {}),
      ...(bash ? { bash } : {}),
      ...(bashClassifier ? { bashClassifier } : {}),
      ...(bashSession ? { bashSession } : {}),
      ...(agentInstall ? { agentInstall } : {}),
      ...(schedulePort
        ? {
            schedules: {
              port: schedulePort,
              sessionCwd: capabilityContext.cwd,
              includeCreate: shouldOfferScheduleCreate(this.hostMode),
            },
          }
        : {}),
      maxSteps: this.maxSteps,
      compaction: this.settings.compaction,
      turnTimeoutMs: this.settings.turnTimeoutMs,
      debugEvents: this.debugEvents,
      ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
      ...(this.structuredOutputProviderOptions
        ? { structuredOutputProviderOptions: this.structuredOutputProviderOptions }
        : {}),
      ...(this.structuredOutputReasoning
        ? { structuredOutputReasoning: this.structuredOutputReasoning }
        : {}),
      onProviderOptionsChange: (providerOptions) => this.syncProviderOptions(providerOptions),
      ...(contextWindowResolution !== undefined
        ? {
            contextWindow: contextWindowResolution.window,
            contextWindowSource: contextWindowResolution.source,
          }
        : {}),
      ...(this.policy ? { policy: this.policy } : {}),
      initialMessages,
      ...(derivedFrom !== undefined ? { derivedFrom } : {}),
      ...(initialCheckpoint ? { initialCheckpoint } : {}),
      ...(store
        ? {
            onAcceptInput: (inputId, message) => store.acceptTurnInput(id, inputId, message),
            onRecordInputSkillCheckpoint: (inputId, checkpoint) =>
              store.recordTurnSkillCheckpoint(id, inputId, checkpoint),
            getInputSkillCheckpoint: (sequence) => store.getTurnInputSkillCheckpoint(id, sequence),
            onPersist: (messages, options) => store.appendMessages(id, messages, options),
            onReplace: (messages) => store.replaceMessages(id, messages),
            onToolExecution: (record) => store.appendToolExecution(id, record),
            listToolExecutions: (options) => store.listToolExecutions(id, options),
            getToolExecution: (executionId) => store.getToolExecution(id, executionId),
            recoverUncoveredToolExecutions: () => this.recoverUncoveredToolExecutionContext(id),
            listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
            commitCompaction: (input) => store.commitCompaction(id, input),
            readCheckpointTranscript: (options) => store.readCheckpointTranscript(id, options),
          }
        : {}),
      onClose: () => {
        if (this.liveSessions.get(id) === session) {
          this.liveSessions.delete(id);
        }
      },
    });
    this.liveSessions.set(id, session);
    return session;
  }

  private recoverUncoveredToolExecutionContext(threadId: string): readonly ModelMessage[] {
    const recovered = this.store?.recoverUncoveredToolExecutions(
      threadId,
      createToolLedgerGapRecoveryMessage,
    );
    return recovered === undefined ? [] : [recovered];
  }

  private readonly assertModelUpdateIdle = (): void => {
    if (this.switchingProviderName !== undefined) {
      throw new Error("模型配置正在更新，请稍后再试");
    }
  };

  private syncProviderOptions(providerOptions: SharedV4ProviderOptions | undefined): void {
    this.assertModelUpdateIdle();
    this.switchingProviderName = this.provider;
    try {
      this.agentHost?.updateSampling(this.modelOverride ?? this.explicitModel, providerOptions);
      this.providerOptions = providerOptions;
    } finally {
      this.switchingProviderName = undefined;
    }
  }

  switchModel(input: EngineModelSwitch): ContextWindowResolution | undefined {
    this.assertAcceptingSessions();
    this.assertModelUpdateIdle();
    this.switchingProviderName = input.provider;
    try {
      const resolution = this.resolveContextWindowFor(input.provider, input.modelName);
      const sessionSwitch = {
        model: input.model,
        ...(input.modelRecovery === undefined ? {} : { modelRecovery: input.modelRecovery }),
        ...(resolution !== undefined
          ? { contextWindow: resolution.window, contextWindowSource: resolution.source }
          : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        ...(input.structuredOutputProviderOptions
          ? { structuredOutputProviderOptions: input.structuredOutputProviderOptions }
          : {}),
        ...(input.structuredOutputReasoning
          ? { structuredOutputReasoning: input.structuredOutputReasoning }
          : {}),
        toolSchemaPolicy: input.toolSchemaPolicy ?? strictToolSchemaPolicy,
      } satisfies SessionModelSwitch;
      for (const session of this.liveSessions.values()) {
        if (!session.canSwitchModel()) {
          throw new Error("存在正在生成回复的会话，稍后再切换模型");
        }
      }
      // Host validation can fail; do it before mutating any session or stored model identity.
      this.agentHost?.updateSampling(input.model, input.providerOptions);
      for (const session of this.liveSessions.values()) {
        session.switchModel(sessionSwitch);
      }
      this.modelOverride = input.model;
      this.modelName = input.modelName;
      this.provider = input.provider;
      this.toolSchemaPolicy = sessionSwitch.toolSchemaPolicy;
      this.providerOptions = input.providerOptions;
      this.modelRecovery = input.modelRecovery;
      this.structuredOutputProviderOptions = input.structuredOutputProviderOptions;
      this.structuredOutputReasoning = input.structuredOutputReasoning;
      for (const id of this.liveSessions.keys()) {
        this.store?.updateModel(id, input.modelName);
      }
      return resolution;
    } finally {
      this.switchingProviderName = undefined;
    }
  }

  private ensureReady(): Promise<EngineContext> {
    this.assertAcceptingSessions();
    if (!this.ready) {
      this.ready = this.bootstrap();
    }
    return this.ready;
  }

  private hostOperation(): AgentHostOperation {
    return {
      model: this.modelOverride ?? this.explicitModel,
      ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
      signal: this.shutdownController.signal,
    };
  }

  private async bootstrap(): Promise<EngineContext> {
    const snapshot: AgentHostSnapshot = this.agentHost
      ? await this.agentHost.prepare(this.hostOperation())
      : { sources: this.explicitSources ?? [] };
    this.assertAcceptingSessions();
    this.resolvedCatalog = snapshot.catalog ?? [];
    const discoveredSkills = snapshot.skillLibrary;
    const skillLibrary =
      this.explicitSkillLibrary === null
        ? undefined
        : (this.explicitSkillLibrary ?? discoveredSkills);
    const model = this.modelOverride ?? this.explicitModel;
    this.agentHost?.updateSampling(model, this.providerOptions);
    return { model, sources: snapshot.sources, ...(skillLibrary ? { skillLibrary } : {}) };
  }

  async prepareAgentRefresh(agentName: string): Promise<SessionAgentRefresh> {
    this.assertAcceptingSessions();
    const result = this.refreshChain.then(() => this.runAgentRefresh(agentName));
    this.refreshChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runAgentRefresh(agentName: string): Promise<SessionAgentRefresh> {
    const context = await this.ensureReady();
    this.assertAcceptingSessions();
    if (!this.agentHost) throw new Error("Agent refresh requires an agentHost");
    const refreshed = await this.agentHost.refresh(agentName, this.hostOperation());
    this.assertAcceptingSessions();
    const sources = [
      ...context.sources.filter((item) => item.agentName !== refreshed.source.agentName),
      refreshed.source,
    ];
    const skillLibrary =
      this.explicitSkillLibrary === null
        ? undefined
        : (this.explicitSkillLibrary ?? refreshed.skillLibrary);
    this.agentHost.updateSampling(this.activeModel(context), this.providerOptions);
    this.ready = Promise.resolve({
      model: this.activeModel(context),
      sources,
      ...(skillLibrary ? { skillLibrary } : {}),
    });
    const skills = skillLibrary?.list() ?? [];
    const effectiveLibrary = skillLibrary && skills.length > 0 ? skillLibrary : undefined;
    const shellProfile = this.resolveRuntimeShellProfile();
    return {
      source: refreshed.source,
      ...(effectiveLibrary ? { skillLibrary: effectiveLibrary } : {}),
      capabilityContext: this.composeCapabilityContext(sources.length, shellProfile),
    };
  }

  private composeCapabilityContext(
    agentCount: number,
    shellProfile: ShellProfile | undefined,
  ): AgentSessionCapabilityContext {
    const onboarding = this.resolveAgentOnboardingInfo();
    return {
      profile: shellProfile?.toolName ?? "no-shell",
      hostMode: this.hostMode,
      cwd: process.cwd(),
      platform: process.platform,
      ...(shellProfile
        ? {
            shellHints: shellProfile.systemPromptHints(),
          }
        : {}),
      agentCount,
      ...(onboarding ? { agentOnboardingCatalog: onboarding } : {}),
    };
  }

  private resolveAgentOnboardingInfo():
    | readonly CapabilityAgentOnboardingCatalogEntry[]
    | undefined {
    return this.resolvedCatalog.length > 0 ? this.resolvedCatalog : undefined;
  }

  private resolveAgentInstallBinding(): AgentSessionAgentInstall | undefined {
    if (!this.agentHost?.install || this.resolvedCatalog.length === 0) return undefined;
    return {
      catalog: this.resolvedCatalog,
      install: (shortName, report) => this.installCatalogAgent(shortName, report),
    };
  }

  private installCatalogAgent(
    shortName: string,
    report: (line: string) => void,
  ): Promise<AgentInstallSessionResult> {
    this.assertAcceptingSessions();
    const operation = this.runAgentInstall(shortName, report);
    this.pendingInstalls.add(operation);
    operation.then(
      () => this.pendingInstalls.delete(operation),
      () => this.pendingInstalls.delete(operation),
    );
    return operation;
  }

  private async runAgentInstall(
    shortName: string,
    report: (line: string) => void,
  ): Promise<AgentInstallSessionResult> {
    const host = this.agentHost;
    if (!host?.install || !this.resolvedCatalog.some((entry) => entry.shortName === shortName)) {
      return { outcome: { ok: false, message: `未知的官方 Agent 短名: ${shortName}` } };
    }
    const { outcome } = await host.install(shortName, report, this.shutdownController.signal);
    // Installation can have completed before cancellation was observed. Keep that fact.
    if (!outcome.ok || this.closing) return { outcome };
    try {
      const context = await this.ensureReady();
      this.assertAcceptingSessions();
      if (context.sources.some((item) => item.agentName === outcome.agentName)) {
        report(`Agent "${outcome.agentName}" 本会话已接入旧版本连接，更新需重启 roll chat 生效。`);
        return { outcome };
      }
      const refresh = await this.prepareAgentRefresh(outcome.agentName);
      return { outcome, refresh };
    } catch (error) {
      report(`接入新 Agent 失败：${error instanceof Error ? error.message : String(error)}`);
      return { outcome };
    }
  }

  private resolveProviderName(): string {
    return this.provider;
  }

  private resolveContextWindowFor(
    provider: string,
    model: string,
  ): ContextWindowResolution | undefined {
    return resolveModelContextWindow({
      provider,
      model,
      ...(this.settings.contextWindow !== undefined
        ? { override: this.settings.contextWindow }
        : {}),
      catalog: this.modelCatalog,
    });
  }

  private resolveModelName(): string {
    return this.modelName;
  }

  private resolveToolSchemaProviderName(): string {
    return this.switchingProviderName ?? this.resolveProviderName();
  }

  private activeModel(context: EngineContext): LanguageModelV4 {
    return this.modelOverride ?? context.model;
  }

  async getContextSummary(): Promise<EngineContextSummary> {
    const context = await this.ensureReady();
    this.assertAcceptingSessions();
    const instructionsPath = this.workspaceInstructions?.current()?.path;
    return {
      agentCount: context.sources.length,
      toolCount: context.sources.reduce((total, source) => total + source.tools.length, 0),
      skillCount: context.skillLibrary?.list().length ?? 0,
      ...(instructionsPath !== undefined ? { instructionsPath } : {}),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.closing = true;
    this.disposePromise = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const closed = await Promise.allSettled(
        [...this.liveSessions.values()].map((session) => session.close()),
      );
      for (const result of closed) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      this.liveSessions.clear();
      await Promise.allSettled([
        ...(this.ready ? [this.ready] : []),
        this.refreshChain,
        ...this.pendingInstalls,
      ]);
      try {
        await this.agentHost?.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "ConversationEngine 关闭 session 与宿主资源失败。");
      }
    });
    this.shutdownController.abort(createEngineClosingError());
    return this.disposePromise;
  }
}
