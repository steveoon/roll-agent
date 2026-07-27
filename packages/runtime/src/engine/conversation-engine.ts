import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import {
  McpClientManager,
  type McpConnectionAcquisition,
} from "@roll-agent/core/mcp/client-manager";
import { createProviderModel } from "@roll-agent/core/llm/providers";
import { AgentStore } from "@roll-agent/core/registry/store";
import { resolveTransportWithDevSpawnSpec } from "@roll-agent/core/registry/dev-spawn";
import {
  getAgentPid,
  startAgent,
  waitForAgentReady,
} from "@roll-agent/core/registry/process-manager";
import {
  acquireAgentUsageLease,
  type AgentUsageLease,
} from "@roll-agent/core/registry/agent-usage-lease";
import { normalizeListedTools } from "@roll-agent/core/cli/utils/agent-tools";
import { getAgentEnv } from "@roll-agent/core/config/helpers";
import { catalogPackageSpec, getAgentCatalog } from "@roll-agent/core/registry/catalog";
import { resolveAgentCatalog } from "@roll-agent/core/registry/catalog-discovery";
import { installAgent } from "@roll-agent/core/registry/install";
import type { AgentCatalogEntry } from "@roll-agent/core/registry/catalog";
import type { InstallAgentEvent } from "@roll-agent/core/registry/install";
import type { RollConfig } from "@roll-agent/core/config/schema";
import type { RegisteredAgent } from "@roll-agent/core/types/agent";
import { createSkillLibrary, type SkillLibrary } from "@roll-agent/core/skills/library";
import {
  ROLL_RESOURCE_HINTS_META_KEY,
  type AgentToolSource,
  type SourceTool,
} from "../tool-bridge/build-tools.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  TOOL_RESOURCE_HINT_KINDS,
  type ToolResourceHint,
} from "../tool-bridge/tool-execution-coordinator.ts";
import type { ToolAnnotations, ToolPolicy } from "../types/policy.ts";
import type { ThreadStore } from "../store/thread-store.ts";
import {
  AgentSession,
  type AgentInstallSessionResult,
  type AgentSessionAgentInstall,
  type AgentSessionBashSession,
  type AgentSessionCapabilityContext,
  type AgentSessionOptions,
  type SessionAgentRefresh,
} from "./agent-session.ts";
import { resolveContextWindow } from "./context-window.ts";
import {
  CAPABILITY_HOST_MODES,
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
import { AGENT_BOOTSTRAP_MAX_CONCURRENCY, mapWithBoundedConcurrency } from "./agent-bootstrap.ts";

const DEFAULT_MAX_STEPS = 80;
const ENGINE_CLOSING_MESSAGE = "ConversationEngine is closing";
const AGENT_BOOTSTRAP_CONNECT_TIMEOUT_MS = 30_000;
const AGENT_BOOTSTRAP_LIST_TOOLS_TIMEOUT_MS = 60_000;

const AGENT_BOOTSTRAP_ATTEMPT_KINDS = {
  connected: "connected",
  failed: "failed",
} as const;

export type EnsureAgentReady = (
  agent: RegisteredAgent,
  env: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
) => Promise<void>;

export type AcquireAgentUsage = (
  agent: RegisteredAgent,
  env: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
) => Promise<AgentUsageLease | undefined>;

export interface ConversationEngineOptions {
  readonly config: RollConfig;
  readonly agents?: readonly RegisteredAgent[];
  readonly model?: LanguageModelV4;
  readonly sources?: readonly AgentToolSource[];
  readonly clientManager?: McpClientManager;
  readonly store?: ThreadStore;
  readonly policy?: ToolPolicy;
  readonly maxSteps?: number;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly structuredOutputProviderOptions?: SharedV4ProviderOptions;
  readonly structuredOutputReasoning?: NonNullable<LanguageModelV4CallOptions["reasoning"]>;
  readonly ensureAgentReady?: EnsureAgentReady;
  readonly acquireAgentUsage?: AcquireAgentUsage;
  readonly debugEvents?: boolean;
  readonly onAgentBootstrapIssue?: (issue: AgentBootstrapIssue) => void;
  readonly skillLibrary?: SkillLibrary | null;
  readonly onSkillLibraryIssue?: (message: string) => void;
  readonly hostMode?: CapabilityHostMode;
  readonly resolveDynamicCapabilityContext?: AgentSessionOptions["resolveDynamicCapabilityContext"];
  readonly sessionExecEnabled?: boolean;
  readonly shellProfile?: ShellProfile | null;
  readonly resolveShellProfileFn?: typeof resolveShellProfile;
  readonly installAgentFn?: typeof installAgent;
  readonly resolveCatalogFn?: typeof resolveAgentCatalog;
  readonly inspectVcsContext?: (
    cwd: string,
  ) => CapabilityVcsSnapshot | undefined | Promise<CapabilityVcsSnapshot | undefined>;
  readonly shellEnv?: NodeJS.ProcessEnv;
}

export interface CreateSessionInput {
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
}

interface EngineContext {
  readonly model: LanguageModelV4;
  readonly sources: readonly AgentToolSource[];
  readonly skillLibrary?: SkillLibrary;
}

type AgentBootstrapAttempt =
  | {
      readonly kind: typeof AGENT_BOOTSTRAP_ATTEMPT_KINDS.connected;
      readonly source: AgentToolSource;
      readonly issues: readonly AgentBootstrapIssue[];
    }
  | {
      readonly kind: typeof AGENT_BOOTSTRAP_ATTEMPT_KINDS.failed;
      readonly issues: readonly AgentBootstrapIssue[];
    };

interface ConnectAgentSourceOptions {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

class AgentBootstrapTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent bootstrap timed out after ${String(timeoutMs)}ms`);
    this.name = "AgentBootstrapTimeoutError";
  }
}

class AgentBootstrapCleanupError extends AggregateError {
  readonly cleanupErrors: readonly unknown[];

  constructor(agentName: string, operationError: unknown, cleanupErrors: readonly unknown[]) {
    const cleanupSummary = cleanupErrors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join("; ");
    super(
      [operationError, ...cleanupErrors],
      `Agent "${agentName}" bootstrap failed and resource cleanup also failed: ${cleanupSummary}`,
    );
    this.name = "AgentBootstrapCleanupError";
    this.cleanupErrors = cleanupErrors;
  }
}

function createEngineClosingError(): Error {
  return new Error(ENGINE_CLOSING_MESSAGE);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function remainingStepTimeout(localTimeoutMs: number, deadlineAt: number | undefined): number {
  if (deadlineAt === undefined) {
    return localTimeoutMs;
  }
  return Math.max(1, Math.min(localTimeoutMs, deadlineAt - Date.now()));
}

function throwIfDeadlineExpired(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new Error("Agent bootstrap deadline expired");
  }
}

function extractAnnotations(listed: unknown): ToolAnnotations | undefined {
  if (typeof listed !== "object" || listed === null || !("annotations" in listed)) {
    return undefined;
  }
  const annotations = (listed as { readonly annotations: unknown }).annotations;
  if (typeof annotations !== "object" || annotations === null) {
    return undefined;
  }
  const result: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
  if (
    "readOnlyHint" in annotations &&
    typeof (annotations as { readonly readOnlyHint: unknown }).readOnlyHint === "boolean"
  ) {
    result.readOnlyHint = (annotations as { readonly readOnlyHint: boolean }).readOnlyHint;
  }
  if (
    "destructiveHint" in annotations &&
    typeof (annotations as { readonly destructiveHint: unknown }).destructiveHint === "boolean"
  ) {
    result.destructiveHint = (annotations as { readonly destructiveHint: boolean }).destructiveHint;
  }
  return result.readOnlyHint === undefined && result.destructiveHint === undefined
    ? undefined
    : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResourceHintKind(value: string): value is ToolResourceHint["kind"] {
  return Object.values(TOOL_RESOURCE_HINT_KINDS).some((kind) => kind === value);
}

function isResourceAccessMode(value: string): value is NonNullable<ToolResourceHint["mode"]> {
  return Object.values(TOOL_RESOURCE_ACCESS_MODES).some((mode) => mode === value);
}

interface ResourceHintExtraction {
  readonly hints: readonly ToolResourceHint[] | undefined;
  readonly issue: string | undefined;
}

function invalidResourceHints(issue: string): ResourceHintExtraction {
  return { hints: undefined, issue };
}

function extractResourceHints(listed: unknown): ResourceHintExtraction {
  if (!isRecord(listed) || !isRecord(listed._meta)) {
    return { hints: undefined, issue: undefined };
  }
  if (!Object.hasOwn(listed._meta, ROLL_RESOURCE_HINTS_META_KEY)) {
    return { hints: undefined, issue: undefined };
  }
  const rawHints = listed._meta[ROLL_RESOURCE_HINTS_META_KEY];
  if (!Array.isArray(rawHints)) {
    return invalidResourceHints("必须是数组");
  }
  const hints: ToolResourceHint[] = [];
  for (const [index, value] of rawHints.entries()) {
    if (
      !isRecord(value) ||
      typeof value.field !== "string" ||
      value.field.trim().length === 0 ||
      typeof value.kind !== "string" ||
      !isResourceHintKind(value.kind) ||
      (value.mode !== undefined &&
        (typeof value.mode !== "string" || !isResourceAccessMode(value.mode))) ||
      (value.namespace !== undefined && typeof value.namespace !== "string") ||
      (value.kind === TOOL_RESOURCE_HINT_KINDS.custom &&
        (typeof value.namespace !== "string" || value.namespace.trim().length === 0))
    ) {
      return invalidResourceHints(`第 ${String(index + 1)} 项字段无效`);
    }
    const namespace =
      value.kind === TOOL_RESOURCE_HINT_KINDS.custom && typeof value.namespace === "string"
        ? value.namespace.trim()
        : undefined;
    hints.push({
      field: value.field.trim(),
      kind: value.kind,
      ...(value.mode !== undefined ? { mode: value.mode } : {}),
      ...(namespace !== undefined ? { namespace } : {}),
    });
  }
  return { hints: hints.length > 0 ? hints : undefined, issue: undefined };
}

function formatInstallEventLine(event: InstallAgentEvent): string {
  if (event.type === "retry") {
    return `安装遇到网络问题，${Math.round(event.delayMs / 1000)}s 后重试（第 ${event.attempt + 1} 次）...`;
  }
  return event.type === "warn" ? `警告：${event.message}` : event.message;
}

async function ensureCoreManagedAgentReady(
  agent: RegisteredAgent,
  dataDir: string,
  env: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (agent.runtime.ownership !== "core-managed") {
    return;
  }

  if (getAgentPid(dataDir, agent.skill.name) === undefined) {
    startAgent(agent, dataDir, env);
  }
  await waitForAgentReady(agent, { ...(signal ? { signal } : {}) });
}

export class ConversationEngine {
  private readonly config: RollConfig;
  private readonly clientManager: McpClientManager;
  private readonly store: ThreadStore | undefined;
  private readonly policy: ToolPolicy | undefined;
  private readonly maxSteps: number;
  private providerOptions: SharedV4ProviderOptions | undefined;
  private readonly structuredOutputProviderOptions: SharedV4ProviderOptions | undefined;
  private readonly structuredOutputReasoning:
    | NonNullable<LanguageModelV4CallOptions["reasoning"]>
    | undefined;
  private readonly acquireAgentUsage: AcquireAgentUsage;
  private readonly debugEvents: boolean;
  private readonly explicitAgents: readonly RegisteredAgent[] | undefined;
  private readonly explicitModel: LanguageModelV4 | undefined;
  private readonly explicitSources: readonly AgentToolSource[] | undefined;
  private readonly explicitSkillLibrary: SkillLibrary | null | undefined;
  private readonly onSkillLibraryIssue: ((message: string) => void) | undefined;
  private readonly onAgentBootstrapIssue: ((issue: AgentBootstrapIssue) => void) | undefined;
  private readonly hostMode: CapabilityHostMode;
  private readonly resolveDynamicCapabilityContext:
    | NonNullable<ConversationEngineOptions["resolveDynamicCapabilityContext"]>
    | undefined;
  private readonly sessionExecEnabled: boolean;
  private readonly explicitShellProfile: ShellProfile | null | undefined;
  private readonly resolveShellProfileFn: typeof resolveShellProfile;
  private readonly installAgentFn: typeof installAgent;
  private readonly resolveCatalogFn: typeof resolveAgentCatalog;
  private readonly inspectVcsContext: NonNullable<ConversationEngineOptions["inspectVcsContext"]>;
  private readonly shellEnv: NodeJS.ProcessEnv;
  private ready: Promise<EngineContext> | undefined;
  private refreshChain: Promise<void> = Promise.resolve();
  private resolvedCatalog: readonly AgentCatalogEntry[] | undefined;
  private shellProfileResolution: ShellProfileResolutionResult | undefined;
  private shellUnsupportedWarned = false;
  private readonly liveSessions = new Map<string, AgentSession>();
  private readonly agentUsageLeases = new Map<string, AgentUsageLease>();
  private readonly shutdownController = new AbortController();
  private disposePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: ConversationEngineOptions) {
    this.config = options.config;
    this.clientManager = options.clientManager ?? new McpClientManager();
    this.store = options.store;
    this.policy = options.policy;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.providerOptions = options.providerOptions;
    this.structuredOutputProviderOptions = options.structuredOutputProviderOptions;
    this.structuredOutputReasoning = options.structuredOutputReasoning;
    this.acquireAgentUsage =
      options.acquireAgentUsage ??
      (options.ensureAgentReady
        ? async (agent, env, signal) => {
            await options.ensureAgentReady?.(agent, env, signal);
            return undefined;
          }
        : (agent, env, signal) => this.acquireDefaultAgentUsage(agent, env, signal));
    this.debugEvents = options.debugEvents ?? false;
    this.hostMode = options.hostMode ?? CAPABILITY_HOST_MODES.embedded;
    this.resolveDynamicCapabilityContext = options.resolveDynamicCapabilityContext;
    this.sessionExecEnabled = options.sessionExecEnabled ?? true;
    this.explicitShellProfile = options.shellProfile;
    this.resolveShellProfileFn = options.resolveShellProfileFn ?? resolveShellProfile;
    this.explicitAgents = options.agents;
    this.explicitModel = options.model;
    this.explicitSources = options.sources;
    this.explicitSkillLibrary = options.skillLibrary;
    this.onSkillLibraryIssue = options.onSkillLibraryIssue;
    this.onAgentBootstrapIssue = options.onAgentBootstrapIssue;
    this.installAgentFn = options.installAgentFn ?? installAgent;
    this.resolveCatalogFn = options.resolveCatalogFn ?? resolveAgentCatalog;
    this.inspectVcsContext = options.inspectVcsContext ?? inspectGitVcsContext;
    this.shellEnv = { ...(options.shellEnv ?? process.env) };
  }

  private async acquireDefaultAgentUsage(
    agent: RegisteredAgent,
    env: Readonly<Record<string, string>> | undefined,
    signal?: AbortSignal,
  ): Promise<AgentUsageLease | undefined> {
    const lease = await acquireAgentUsageLease(agent, this.config.agents.dataDir, env, {
      holderKind: "chat",
      startIfStopped: true,
      ...(signal ? { signal } : {}),
    });
    if (lease !== undefined) return lease;

    await ensureCoreManagedAgentReady(agent, this.config.agents.dataDir, env, signal);
    return undefined;
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    this.assertAcceptingSessions();
    const context = await this.ensureReady();
    this.assertAcceptingSessions();
    const id = this.store
      ? this.store.createThread({
          ...(input.title ? { title: input.title } : {}),
          model: this.resolveModelName(),
        })
      : randomUUID();
    return this.buildSession(context, id, []);
  }

  async resumeSession(threadId: string): Promise<AgentSession> {
    this.assertAcceptingSessions();
    if (!this.store) {
      throw new Error("resumeSession requires a ThreadStore");
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
    const state = this.store.loadSessionState(threadId);
    return this.buildSession(context, threadId, state.messages, state.checkpoint);
  }

  private assertAcceptingSessions(): void {
    if (this.closing) {
      throw createEngineClosingError();
    }
  }

  private resolveRuntimeShellProfile(): ShellProfile | undefined {
    const shell = this.config.runtime.shell;
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
    const shell = this.config.runtime.shell;
    return {
      workdir: process.cwd(),
      defaultTimeoutMs: shell.defaultTimeoutMs,
      maxTimeoutMs: shell.maxTimeoutMs,
      turnTimeoutMs: this.config.runtime.turnTimeoutMs,
      maxCaptureBytes: shell.maxCaptureBytes,
      maxModelOutputChars: shell.maxModelOutputChars,
      profile,
      env: this.shellEnv,
    };
  }

  private resolveSessionExecSettings(profile: ShellProfile): AgentSessionBashSession | undefined {
    if (!this.sessionExecEnabled) {
      return undefined;
    }
    const shell = this.config.runtime.shell;
    if (!shell.enabled || !shell.session.enabled) {
      return undefined;
    }
    if (!profile.supportsSessionExec) {
      return undefined;
    }
    return {
      workdir: process.cwd(),
      profile,
      maxSessions: shell.session.maxSessions,
      defaultYieldMs: shell.session.defaultYieldMs,
      maxOutputTokens: shell.session.maxOutputTokens,
      bufferCapacity: shell.maxCaptureBytes,
      env: this.shellEnv,
    };
  }

  private buildSession(
    context: EngineContext,
    id: string,
    initialMessages: readonly ModelMessage[],
    initialCheckpoint?: ReturnType<ThreadStore["getLatestCheckpoint"]>,
  ): AgentSession {
    const store = this.store;
    const contextWindow = resolveContextWindow(
      this.resolveModelName(),
      this.config.runtime.contextWindow,
    );
    const skills = context.skillLibrary?.list() ?? [];
    const skillLibrary = skills.length > 0 ? context.skillLibrary : undefined;
    const shellProfile = this.resolveRuntimeShellProfile();
    const bash = shellProfile ? this.resolveShellSettings(shellProfile) : undefined;
    const bashSession = shellProfile ? this.resolveSessionExecSettings(shellProfile) : undefined;
    const bashClassifier: CommandClassifier | undefined = shellProfile
      ? shellProfile.supportsSafeCommandClassification && this.config.runtime.shell.autoApproveSafe
        ? shellProfile
        : unknownCommandClassifier
      : undefined;
    const agentInstall = this.resolveAgentInstallBinding();
    const capabilityContext = this.composeCapabilityContext(context.sources.length, shellProfile);
    const session = new AgentSession({
      id,
      model: context.model,
      sources: context.sources,
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
        };
      },
      ...(skillLibrary ? { skillLibrary } : {}),
      ...(bash ? { bash } : {}),
      ...(bashClassifier ? { bashClassifier } : {}),
      ...(bashSession ? { bashSession } : {}),
      ...(agentInstall ? { agentInstall } : {}),
      maxSteps: this.maxSteps,
      compaction: this.config.runtime.compaction,
      turnTimeoutMs: this.config.runtime.turnTimeoutMs,
      debugEvents: this.debugEvents,
      ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
      ...(this.structuredOutputProviderOptions
        ? { structuredOutputProviderOptions: this.structuredOutputProviderOptions }
        : {}),
      ...(this.structuredOutputReasoning
        ? { structuredOutputReasoning: this.structuredOutputReasoning }
        : {}),
      onProviderOptionsChange: (providerOptions) => this.syncProviderOptions(providerOptions),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(this.policy ? { policy: this.policy } : {}),
      initialMessages,
      ...(initialCheckpoint ? { initialCheckpoint } : {}),
      ...(store
        ? {
            onPersist: (messages) => store.appendMessages(id, messages),
            onReplace: (messages) => store.replaceMessages(id, messages),
            onToolExecution: (record) => store.appendToolExecution(id, record),
            listToolExecutions: (options) => store.listToolExecutions(id, options),
            getToolExecution: (executionId) => store.getToolExecution(id, executionId),
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

  private syncProviderOptions(providerOptions: SharedV4ProviderOptions | undefined): void {
    this.providerOptions = providerOptions;
    this.clientManager.setSamplingProviderOptions(providerOptions);
  }

  private ensureReady(): Promise<EngineContext> {
    this.assertAcceptingSessions();
    if (!this.ready) {
      this.ready = this.bootstrap();
    }
    return this.ready;
  }

  private async bootstrap(): Promise<EngineContext> {
    const bootstrapStartedAt = Date.now();
    const model = this.explicitModel ?? this.resolveModel();
    if (this.explicitSources) {
      return {
        model,
        sources: this.explicitSources,
        ...(this.explicitSkillLibrary ? { skillLibrary: this.explicitSkillLibrary } : {}),
      };
    }
    const agents = this.explicitAgents ?? new AgentStore(this.config.agents.dataDir).list();
    const timeoutMs = this.config.runtime.agentBootstrap.timeoutMs;
    const deadlineAt = bootstrapStartedAt + timeoutMs;
    const operationController = new AbortController();
    const timeoutError = new AgentBootstrapTimeoutError(timeoutMs);
    let timedOut = false;
    const abortForClosing = (): void => {
      if (!operationController.signal.aborted) {
        operationController.abort(abortReason(this.shutdownController.signal));
      }
    };
    const expireBudgetIfNeeded = (): void => {
      if (!this.closing && !operationController.signal.aborted && Date.now() >= deadlineAt) {
        timedOut = true;
        operationController.abort(timeoutError);
      }
    };
    if (this.shutdownController.signal.aborted) {
      abortForClosing();
    } else {
      this.shutdownController.signal.addEventListener("abort", abortForClosing, { once: true });
    }
    const timeoutHandle = setTimeout(
      () => {
        if (!this.closing && !operationController.signal.aborted) {
          timedOut = true;
          operationController.abort(timeoutError);
        }
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    timeoutHandle.unref();

    const timeoutAttempt = (
      agent: RegisteredAgent,
      cleanupError?: AgentBootstrapCleanupError,
    ): AgentBootstrapAttempt => ({
      kind: AGENT_BOOTSTRAP_ATTEMPT_KINDS.failed,
      issues: [
        {
          agentName: agent.skill.name,
          message: timeoutError.message,
        },
        ...(cleanupError === undefined
          ? []
          : [
              {
                agentName: agent.skill.name,
                message: cleanupError.message,
              },
            ]),
      ],
    });

    try {
      if (this.agentInstallEnabled()) {
        try {
          this.resolvedCatalog = await this.resolveCatalogFn(this.config, {
            allowNetwork: false,
            signal: operationController.signal,
            ...(this.config.install.registry ? { registry: this.config.install.registry } : {}),
          });
        } catch (error) {
          if (this.closing || this.shutdownController.signal.aborted) {
            throw createEngineClosingError();
          }
          expireBudgetIfNeeded();
          if (!timedOut) throw error;
        }
      }
      if (this.closing || this.shutdownController.signal.aborted) {
        throw createEngineClosingError();
      }
      expireBudgetIfNeeded();
      if (agents.length === 0) {
        const skillLibrary = this.resolveSkillLibrary(agents);
        return { model, sources: [], ...(skillLibrary ? { skillLibrary } : {}) };
      }
      const attempts = await mapWithBoundedConcurrency(
        agents,
        AGENT_BOOTSTRAP_MAX_CONCURRENCY,
        async (agent): Promise<AgentBootstrapAttempt> => {
          const issues: AgentBootstrapIssue[] = [];
          const reportIssue = (issue: AgentBootstrapIssue): void => {
            issues.push(issue);
          };
          try {
            expireBudgetIfNeeded();
            throwIfAborted(operationController.signal);
            const source = await this.connectAgentSource(agent, model, reportIssue, {
              signal: operationController.signal,
              deadlineAt,
            });
            return {
              kind: AGENT_BOOTSTRAP_ATTEMPT_KINDS.connected,
              source,
              issues,
            };
          } catch (error) {
            if (this.closing || this.shutdownController.signal.aborted) {
              throw createEngineClosingError();
            }
            expireBudgetIfNeeded();
            if (timedOut) {
              return timeoutAttempt(
                agent,
                error instanceof AgentBootstrapCleanupError ? error : undefined,
              );
            }
            issues.push({
              agentName: agent.skill.name,
              message: error instanceof Error ? error.message : String(error),
            });
            return {
              kind: AGENT_BOOTSTRAP_ATTEMPT_KINDS.failed,
              issues,
            };
          }
        },
        {
          signal: operationController.signal,
          onSkipped: (agent) => timeoutAttempt(agent),
        },
      );
      if (this.closing || this.shutdownController.signal.aborted) {
        throw createEngineClosingError();
      }
      const sources: AgentToolSource[] = [];
      for (const attempt of attempts) {
        for (const issue of attempt.issues) {
          this.onAgentBootstrapIssue?.(issue);
        }
        if (attempt.kind === AGENT_BOOTSTRAP_ATTEMPT_KINDS.connected) {
          sources.push(attempt.source);
        }
      }

      const skillLibrary = this.resolveSkillLibrary(agents);
      return { model, sources, ...(skillLibrary ? { skillLibrary } : {}) };
    } finally {
      clearTimeout(timeoutHandle);
      this.shutdownController.signal.removeEventListener("abort", abortForClosing);
    }
  }

  private async connectAgentSource(
    agent: RegisteredAgent,
    model: LanguageModelV4,
    reportIssue: (issue: AgentBootstrapIssue) => void = (issue) =>
      this.onAgentBootstrapIssue?.(issue),
    options: ConnectAgentSourceOptions = {},
  ): Promise<AgentToolSource> {
    this.assertAcceptingSessions();
    throwIfAborted(options.signal);
    throwIfDeadlineExpired(options.deadlineAt);
    const transport = resolveTransportWithDevSpawnSpec(agent);
    const env = getAgentEnv(this.config, agent.skill.name);
    const existingLease = this.agentUsageLeases.get(agent.skill.name);
    let acquiredLease: AgentUsageLease | undefined;
    let connectionAcquisition: McpConnectionAcquisition | undefined;
    try {
      acquiredLease =
        existingLease === undefined
          ? await this.acquireAgentUsage(agent, env, options.signal)
          : undefined;
      this.assertAcceptingSessions();
      throwIfAborted(options.signal);
      throwIfDeadlineExpired(options.deadlineAt);
      const connectOptions = {
        timeoutMs: remainingStepTimeout(AGENT_BOOTSTRAP_CONNECT_TIMEOUT_MS, options.deadlineAt),
        samplingModel: model,
        ...(this.providerOptions ? { samplingProviderOptions: this.providerOptions } : {}),
        ...(env ? { env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const connectWithOwnership = this.clientManager.connectWithOwnership;
      connectionAcquisition =
        typeof connectWithOwnership === "function"
          ? await connectWithOwnership.call(
              this.clientManager,
              agent.skill.name,
              transport,
              agent.installPath,
              connectOptions,
            )
          : {
              client: await this.clientManager.connect(
                agent.skill.name,
                transport,
                agent.installPath,
                connectOptions,
              ),
              commit: () => {},
              rollback: async () => {},
            };
      this.assertAcceptingSessions();
      throwIfAborted(options.signal);
      throwIfDeadlineExpired(options.deadlineAt);
      const listed = (
        await connectionAcquisition.client.listTools(undefined, {
          timeout: remainingStepTimeout(AGENT_BOOTSTRAP_LIST_TOOLS_TIMEOUT_MS, options.deadlineAt),
          ...(options.signal ? { signal: options.signal } : {}),
        })
      ).tools;
      this.assertAcceptingSessions();
      throwIfAborted(options.signal);
      throwIfDeadlineExpired(options.deadlineAt);
      const normalized = normalizeListedTools(listed);
      const sourceTools: SourceTool[] = normalized.map((agentTool, index) => {
        const resourceHintExtraction = extractResourceHints(listed[index]);
        if (resourceHintExtraction.issue !== undefined) {
          reportIssue({
            agentName: agent.skill.name,
            message: `Tool "${agentTool.name}" 的 ${ROLL_RESOURCE_HINTS_META_KEY} 无效（${resourceHintExtraction.issue}），已回退 Agent 级资源锁`,
          });
        }
        return {
          tool: agentTool,
          annotations: extractAnnotations(listed[index]),
          ...(resourceHintExtraction.hints ? { resourceHints: resourceHintExtraction.hints } : {}),
        };
      });
      connectionAcquisition.commit();
      if (acquiredLease !== undefined) {
        this.agentUsageLeases.set(agent.skill.name, acquiredLease);
      }
      return {
        agentName: agent.skill.name,
        client: connectionAcquisition.client,
        tools: sourceTools,
        ...(agent.source ? { agentSource: agent.source.type } : {}),
        transport: transport.type,
        runtimeOwnership: agent.runtime.ownership,
        ...(transport.type === "stdio" ? { resourceBaseDir: agent.installPath } : {}),
      };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (connectionAcquisition !== undefined) {
        await connectionAcquisition.rollback().catch((cleanupError: unknown) => {
          cleanupErrors.push(cleanupError);
        });
      }
      if (acquiredLease !== undefined) {
        const leaseToRelease = acquiredLease;
        await leaseToRelease.release().catch((cleanupError: unknown) => {
          this.agentUsageLeases.set(agent.skill.name, leaseToRelease);
          cleanupErrors.push(cleanupError);
        });
      }
      if (cleanupErrors.length > 0) {
        throw new AgentBootstrapCleanupError(agent.skill.name, error, cleanupErrors);
      }
      throw error;
    }
  }

  async prepareAgentRefresh(agent: RegisteredAgent): Promise<SessionAgentRefresh> {
    this.assertAcceptingSessions();
    const result = this.refreshChain.then(() => this.runAgentRefresh(agent));
    this.refreshChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runAgentRefresh(agent: RegisteredAgent): Promise<SessionAgentRefresh> {
    const context = await this.ensureReady();
    const source = await this.connectAgentSource(agent, context.model, undefined, {
      signal: this.shutdownController.signal,
    });
    const sources = [
      ...context.sources.filter((item) => item.agentName !== source.agentName),
      source,
    ];
    const agents = this.explicitAgents ?? new AgentStore(this.config.agents.dataDir).list();
    const skillLibrary = this.resolveSkillLibrary(agents);
    this.ready = Promise.resolve({
      model: context.model,
      sources,
      ...(skillLibrary ? { skillLibrary } : {}),
    });
    const skills = skillLibrary?.list() ?? [];
    const effectiveLibrary = skillLibrary && skills.length > 0 ? skillLibrary : undefined;
    const shellProfile = this.resolveRuntimeShellProfile();
    return {
      source,
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

  private agentInstallEnabled(): boolean {
    return this.explicitSources === undefined && this.explicitAgents === undefined;
  }

  private currentCatalog(): readonly AgentCatalogEntry[] {
    return this.resolvedCatalog ?? getAgentCatalog(this.config);
  }

  private resolveAgentOnboardingInfo():
    | readonly CapabilityAgentOnboardingCatalogEntry[]
    | undefined {
    if (!this.agentInstallEnabled()) {
      return undefined;
    }
    const catalog = this.currentCatalog();
    if (catalog.length === 0) {
      return undefined;
    }
    return catalog.map((entry) => ({
      shortName: entry.shortName,
      description: entry.description,
    }));
  }

  private resolveAgentInstallBinding(): AgentSessionAgentInstall | undefined {
    if (!this.agentInstallEnabled()) {
      return undefined;
    }
    const catalog = this.currentCatalog();
    if (catalog.length === 0) {
      return undefined;
    }
    return {
      catalog: catalog.map((entry) => ({
        shortName: entry.shortName,
        description: entry.description,
      })),
      install: (shortName, report) => this.installCatalogAgent(shortName, report),
    };
  }

  private async installCatalogAgent(
    shortName: string,
    report: (line: string) => void,
  ): Promise<AgentInstallSessionResult> {
    const entry = this.currentCatalog().find((item) => item.shortName === shortName);
    if (!entry) {
      return { outcome: { ok: false, message: `未知的官方 Agent 短名: ${shortName}` } };
    }

    const result = await this.installAgentFn(
      {
        packageSpec: catalogPackageSpec(entry),
        skipBrowserSetup: true,
        autoStart: false,
        expectedSkillName: entry.skillName,
      },
      {
        agentsConfig: this.config.agents,
        installConfig: this.config.install,
        getStartEnv: (agentName) => getAgentEnv(this.config, agentName),
        report: (event) => report(formatInstallEventLine(event)),
      },
    );
    if (!result.ok) {
      return {
        outcome: {
          ok: false,
          message: result.message,
          ...(result.retryCommand ? { retryCommand: result.retryCommand } : {}),
        },
      };
    }

    const agent = result.agent;
    const version =
      agent.source?.type === "installed-package" ? agent.source.installedVersion : undefined;
    const browserSetupSkipped =
      agent.runtime.ownership === "core-managed" && agent.runtime.setup?.playwright !== undefined;
    const outcome = {
      ok: true as const,
      agentName: agent.skill.name,
      ...(version ? { version } : {}),
      missingEnv: (result.envReport?.missingRequired ?? []).map((item) => item.name),
      ...(browserSetupSkipped ? { retryCommand: `roll agent install ${entry.shortName}` } : {}),
      refreshApplied: false,
    };

    const context = await this.ensureReady();
    if (context.sources.some((item) => item.agentName === agent.skill.name)) {
      report(`Agent "${agent.skill.name}" 本会话已接入旧版本连接，更新需重启 roll chat 生效。`);
      return { outcome };
    }

    try {
      const refresh = await this.prepareAgentRefresh(agent);
      return { outcome, refresh };
    } catch (error) {
      report(`接入新 Agent 失败：${error instanceof Error ? error.message : String(error)}`);
      return { outcome };
    }
  }

  private resolveSkillLibrary(agents: readonly RegisteredAgent[]): SkillLibrary | undefined {
    if (this.explicitSkillLibrary === null) {
      return undefined;
    }
    if (this.explicitSkillLibrary !== undefined) {
      return this.explicitSkillLibrary;
    }
    return createSkillLibrary({
      agents,
      extraDirs: this.config.skills.dirs,
      ...(this.onSkillLibraryIssue ? { onIssue: this.onSkillLibraryIssue } : {}),
    });
  }

  private resolveModel(): LanguageModelV4 {
    const provider = this.resolveProviderName();
    const modelName = this.resolveModelName();
    const providerConfig = this.config.llm.providers[provider];
    if (!providerConfig) {
      throw new Error(`LLM provider "${provider}" 未配置`);
    }
    return createProviderModel(provider, modelName, providerConfig.apiKey, providerConfig.baseUrl);
  }

  private resolveProviderName(): string {
    return this.config.runtime.provider ?? this.config.llm.defaultProvider;
  }

  private resolveModelName(): string {
    return this.config.runtime.model ?? this.config.llm.defaultModel;
  }

  async getContextSummary(): Promise<EngineContextSummary> {
    const context = await this.ensureReady();
    this.assertAcceptingSessions();
    return {
      agentCount: context.sources.length,
      toolCount: context.sources.reduce((total, source) => total + source.tools.length, 0),
      skillCount: context.skillLibrary?.list().length ?? 0,
    };
  }

  private async releaseAgentUsageLeases(): Promise<void> {
    const entries = [...this.agentUsageLeases.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([agentName, lease]) => {
        try {
          await lease.release();
        } finally {
          if (this.agentUsageLeases.get(agentName) === lease) {
            this.agentUsageLeases.delete(agentName);
          }
        }
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        process.stderr.write(
          `roll chat: Agent 使用租约释放失败: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }\n`,
        );
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    this.closing = true;
    this.shutdownController.abort(createEngineClosingError());
    const pendingEngineWork = Promise.allSettled([
      ...(this.ready ? [this.ready] : []),
      this.refreshChain,
    ]).then(() => undefined);
    this.disposePromise = (async () => {
      let closeFailure:
        | { readonly failed: false }
        | { readonly failed: true; readonly error: unknown } = { failed: false };
      try {
        await Promise.all([...this.liveSessions.values()].map((session) => session.close()));
      } catch (error) {
        closeFailure = { failed: true, error };
      }
      this.liveSessions.clear();
      await pendingEngineWork;
      let disconnectFailure:
        | { readonly failed: false }
        | { readonly failed: true; readonly error: unknown } = { failed: false };
      try {
        await this.clientManager.disconnectAll();
      } catch (error) {
        disconnectFailure = { failed: true, error };
      }
      await this.releaseAgentUsageLeases();
      if (closeFailure.failed && disconnectFailure.failed) {
        throw new AggregateError(
          [closeFailure.error, disconnectFailure.error],
          "ConversationEngine 关闭 session 与 MCP 连接均失败。",
        );
      }
      if (closeFailure.failed) throw closeFailure.error;
      if (disconnectFailure.failed) throw disconnectFailure.error;
    })();
    return this.disposePromise;
  }
}
