import { randomUUID } from "node:crypto";
import { waitForPromiseSettlement } from "../bounded-wait.ts";
import type { ModelMessage } from "ai";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import { McpClientManager } from "@roll-agent/core/mcp/client-manager";
import { createProviderModel } from "@roll-agent/core/llm/providers";
import { AgentStore } from "@roll-agent/core/registry/store";
import { resolveTransportWithDevSpawnSpec } from "@roll-agent/core/registry/dev-spawn";
import {
  getAgentPid,
  startAgent,
  waitForAgentReady,
} from "@roll-agent/core/registry/process-manager";
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

const DEFAULT_MAX_STEPS = 80;
const ENGINE_WORK_DRAIN_TIMEOUT_MS = 6_000;

export type EnsureAgentReady = (
  agent: RegisteredAgent,
  env: Readonly<Record<string, string>> | undefined,
) => Promise<void>;

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
  readonly ensureAgentReady?: EnsureAgentReady;
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
): Promise<void> {
  if (agent.runtime.ownership !== "core-managed") {
    return;
  }

  if (getAgentPid(dataDir, agent.skill.name) === undefined) {
    startAgent(agent, dataDir, env);
  }
  await waitForAgentReady(agent);
}

export class ConversationEngine {
  private readonly config: RollConfig;
  private readonly clientManager: McpClientManager;
  private readonly store: ThreadStore | undefined;
  private readonly policy: ToolPolicy | undefined;
  private readonly maxSteps: number;
  private providerOptions: SharedV4ProviderOptions | undefined;
  private readonly ensureAgentReady: EnsureAgentReady;
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
  private disposePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: ConversationEngineOptions) {
    this.config = options.config;
    this.clientManager = options.clientManager ?? new McpClientManager();
    this.store = options.store;
    this.policy = options.policy;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.providerOptions = options.providerOptions;
    this.ensureAgentReady =
      options.ensureAgentReady ??
      ((agent, env) => ensureCoreManagedAgentReady(agent, this.config.agents.dataDir, env));
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
      throw new Error("ConversationEngine is closing");
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
    const model = this.explicitModel ?? this.resolveModel();
    if (this.explicitSources) {
      return {
        model,
        sources: this.explicitSources,
        ...(this.explicitSkillLibrary ? { skillLibrary: this.explicitSkillLibrary } : {}),
      };
    }
    const agents = this.explicitAgents ?? new AgentStore(this.config.agents.dataDir).list();
    if (this.agentInstallEnabled()) {
      this.resolvedCatalog = await this.resolveCatalogFn(this.config, {
        allowNetwork: false,
        ...(this.config.install.registry ? { registry: this.config.install.registry } : {}),
      });
    }
    const sources: AgentToolSource[] = [];

    for (const agent of agents) {
      try {
        sources.push(await this.connectAgentSource(agent, model));
      } catch (error) {
        this.onAgentBootstrapIssue?.({
          agentName: agent.skill.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const skillLibrary = this.resolveSkillLibrary(agents);
    return { model, sources, ...(skillLibrary ? { skillLibrary } : {}) };
  }

  private async connectAgentSource(
    agent: RegisteredAgent,
    model: LanguageModelV4,
  ): Promise<AgentToolSource> {
    this.assertAcceptingSessions();
    const transport = resolveTransportWithDevSpawnSpec(agent);
    const env = getAgentEnv(this.config, agent.skill.name);
    await this.ensureAgentReady(agent, env);
    this.assertAcceptingSessions();
    const client = await this.clientManager.connect(
      agent.skill.name,
      transport,
      agent.installPath,
      {
        samplingModel: model,
        ...(this.providerOptions ? { samplingProviderOptions: this.providerOptions } : {}),
        ...(env ? { env } : {}),
      },
    );
    this.assertAcceptingSessions();
    const listed = (await client.listTools()).tools;
    this.assertAcceptingSessions();
    const normalized = normalizeListedTools(listed);
    const sourceTools: SourceTool[] = normalized.map((agentTool, index) => {
      const resourceHintExtraction = extractResourceHints(listed[index]);
      if (resourceHintExtraction.issue !== undefined) {
        this.onAgentBootstrapIssue?.({
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
    return {
      agentName: agent.skill.name,
      client,
      tools: sourceTools,
      ...(agent.source ? { agentSource: agent.source.type } : {}),
      transport: transport.type,
      runtimeOwnership: agent.runtime.ownership,
      ...(transport.type === "stdio" ? { resourceBaseDir: agent.installPath } : {}),
    };
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
    const source = await this.connectAgentSource(agent, context.model);
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
        autoStart: true,
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

  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    this.closing = true;
    const pendingEngineWork = Promise.allSettled([
      ...(this.ready ? [this.ready] : []),
      this.refreshChain,
    ]).then(() => undefined);
    this.disposePromise = (async () => {
      try {
        await Promise.all([...this.liveSessions.values()].map((session) => session.close()));
      } finally {
        this.liveSessions.clear();
        const drained = await waitForPromiseSettlement(
          pendingEngineWork,
          ENGINE_WORK_DRAIN_TIMEOUT_MS,
        );
        if (!drained) {
          process.stderr.write(
            `roll chat: Engine 在 ${String(ENGINE_WORK_DRAIN_TIMEOUT_MS)}ms 内未完成在飞初始化，将在其结束后再清理迟到连接\n`,
          );
        }
        await this.clientManager.disconnectAll();
        if (!drained) {
          pendingEngineWork
            .then(() => this.clientManager.disconnectAll())
            .catch((error: unknown) => {
              process.stderr.write(
                `roll chat: 迟到 MCP 连接清理失败: ${error instanceof Error ? error.message : String(error)}\n`,
              );
            });
        }
      }
    })();
    return this.disposePromise;
  }
}
