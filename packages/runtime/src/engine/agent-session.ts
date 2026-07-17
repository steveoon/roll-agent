import { createHash, randomUUID } from "node:crypto";
import { waitForPromiseSettlement } from "../bounded-wait.ts";
import {
  stepCountIs,
  streamText,
  InvalidToolInputError,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type UserModelMessage,
} from "ai";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { SkillLibrary, SkillSummary } from "@roll-agent/core/skills/library";
import type {
  ContextCompactionReason,
  ContextCompactionStrategy,
  SessionDebugData,
  SessionDebugStage,
  SessionEvent,
  SessionTokenUsage,
} from "../types/events.ts";
import type { ToolPolicy } from "../types/policy.ts";
import {
  buildAgentToolset,
  type AgentToolSource,
  type ApprovalRequest,
} from "../tool-bridge/build-tools.ts";
import {
  buildAgentInstallToolset,
  type AgentInstallToolCatalogEntry,
  type AgentInstallToolOutcome,
} from "../tool-bridge/agent-install-tool.ts";
import { buildSkillToolset } from "../tool-bridge/skill-tool.ts";
import {
  buildBashToolset,
  type BashToolContext,
  type SessionBashSettings,
} from "../tool-bridge/bash-tool.ts";
import {
  EXEC_COMMAND_NAME,
  EXEC_LIST_NAME,
  EXEC_POLL_NAME,
  buildSessionExecToolset,
} from "../tool-bridge/session-exec-tool.ts";
import { SessionManager } from "../bash/session/session-manager.ts";
import { withCleanEnv } from "../bash/clean-env.ts";
import type { ShellProfile } from "../bash/profile.ts";
import type { CommandClassifier } from "../types/command-classification.ts";
import {
  RUNTIME_CANCELLATION_ABORT_REASON,
  SESSION_CANCELLATION_REASONS,
  TURN_TIMEOUT_ABORT_REASON,
  USER_CANCELLATION_ABORT_REASON,
  isTurnTimeoutAbortReason,
  type SessionCancellationReason,
} from "../types/cancellation.ts";
import { ToolRegistry } from "../tool-bridge/naming.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  isNormalizedToolResult,
  normalizeToolResult,
  readDisplayOutput,
  readToolOutcome,
} from "../tool-bridge/normalize-result.ts";
import {
  createToolExecutionRecord,
  toRedactedToolExecutionRecordSummary,
  type RedactedToolExecutionRecordSummary,
  type ToolExecutionRecord,
} from "../tool-bridge/tool-execution-record.ts";
import type {
  CommitCompactionInput,
  ListToolExecutionsOptions,
  ListTranscriptMessagesOptions,
  SequencedToolExecutionRecord,
} from "../store/thread-store.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  ToolExecutionCoordinator,
  type ToolResourceAccess,
} from "../tool-bridge/tool-execution-coordinator.ts";
import { ApprovalGate, type ApprovalDecision } from "../approval/approval-gate.ts";
import { compactMessages, SUMMARY_PREFIX } from "./compactor.ts";
import { AsyncEventQueue } from "./event-queue.ts";
import {
  attachExplicitSkillCheckpoint,
  materializeExplicitSkillCheckpoints,
  prepareExplicitSkillContext,
  readExplicitSkillCheckpoint,
  stripExplicitSkillCheckpoints,
} from "./explicit-skill-context.ts";
import {
  CAPABILITY_HOST_MODES,
  CAPABILITY_TOOL_ROLES,
  buildEffectiveCapabilityTurnContext,
  buildEffectiveCapabilityManifest,
  findCapabilityToolId,
  type CapabilityAgentOnboardingCatalogEntry,
  type CapabilityExternalDynamicContext,
  type CapabilityHostMode,
  type CapabilityToolRole,
  type EffectiveCapabilityTurnContext,
  type EffectiveCapabilityManifest,
} from "./capability-manifest.ts";
import { buildCapabilityTurnReminder, buildChatSystemPromptFromManifest } from "./system-prompt.ts";
import {
  buildCompactionCheckpointReminder,
  buildCompactionToolState,
  createCompactionSummary,
  findLatestRealUserGoal,
  resolveActiveCompactionConstraints,
  type ArchivedTranscriptMessage,
  type CompactionCheckpoint,
  type CompactionCheckpointDraftInput,
  type CompactionResource,
  type CompactionRunningWork,
  type CompactionSummary,
} from "./compaction-checkpoint.ts";
import {
  ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS,
  repairActiveToolProtocol,
} from "./tool-protocol-repair.ts";
import { buildTranscriptToolset, type TranscriptReader } from "../tool-bridge/transcript-tool.ts";
import { isTerminalSessionState } from "../bash/session/types.ts";

export interface SessionCompactionSettings {
  readonly enabled: boolean;
  readonly strategy: ContextCompactionStrategy;
  readonly threshold: number;
  readonly keepRecentTurns: number;
  readonly keepRecentTokens: number;
}

export interface AgentSessionOptions {
  readonly id: string;
  readonly model: LanguageModelV4;
  readonly sources: readonly AgentToolSource[];
  readonly maxSteps: number;
  readonly policy?: ToolPolicy;
  readonly initialMessages?: readonly ModelMessage[];
  readonly onPersist?: (messages: readonly ModelMessage[]) => void;
  readonly onReplace?: (messages: readonly ModelMessage[]) => void;
  readonly onToolExecution?: (record: ToolExecutionRecord) => void;
  readonly listToolExecutions?: (
    options?: ListToolExecutionsOptions,
  ) => readonly SequencedToolExecutionRecord[];
  readonly getToolExecution?: (executionId: string) => SequencedToolExecutionRecord | undefined;
  readonly initialCheckpoint?: CompactionCheckpoint;
  readonly listTranscriptMessages?: (
    options?: ListTranscriptMessagesOptions,
  ) => readonly ArchivedTranscriptMessage[];
  readonly commitCompaction?: (input: CommitCompactionInput) => CompactionCheckpoint;
  readonly readCheckpointTranscript?: TranscriptReader;
  readonly contextWindow?: number;
  readonly compaction?: SessionCompactionSettings;
  readonly turnTimeoutMs?: number;
  readonly providerOptions?: SharedV4ProviderOptions;
  /** `setProviderOptions()` 生效后触发；ConversationEngine 用它同步子 Agent Sampling。 */
  readonly onProviderOptionsChange?: (providerOptions: SharedV4ProviderOptions | undefined) => void;
  readonly debugEvents?: boolean;
  /**
   * 追加到 capability-driven 基础 prompt 之后的会话指令。
   * 保留旧字段名以兼容调用方；它不能替换工具接地与能力清单。
   */
  readonly systemPrompt?: string;
  readonly capabilityContext?: AgentSessionCapabilityContext;
  readonly resolveDynamicCapabilityContext?: () =>
    | CapabilityExternalDynamicContext
    | Promise<CapabilityExternalDynamicContext>;
  readonly skillLibrary?: SkillLibrary;
  readonly bash?: SessionBashSettings;
  readonly bashClassifier?: CommandClassifier;
  readonly bashSession?: AgentSessionBashSession;
  readonly agentInstall?: AgentSessionAgentInstall;
  readonly onClose?: () => void;
}

export interface AgentSessionCapabilityContext {
  readonly profile: string;
  readonly hostMode?: CapabilityHostMode;
  readonly cwd: string;
  readonly platform?: NodeJS.Platform;
  readonly shellHints?: readonly string[];
  readonly agentCount: number;
  readonly agentOnboardingCatalog?: readonly CapabilityAgentOnboardingCatalogEntry[];
}

export interface SessionAgentRefresh {
  readonly source: AgentToolSource;
  readonly skillLibrary?: SkillLibrary;
  /** 追加到重新编译后的 capability-driven prompt，不能整体替换基础 prompt。 */
  readonly systemPrompt?: string;
  readonly capabilityContext?: AgentSessionCapabilityContext;
}

export interface AgentInstallSessionResult {
  readonly outcome: AgentInstallToolOutcome;
  readonly refresh?: SessionAgentRefresh;
}

export interface AgentSessionAgentInstall {
  readonly catalog: readonly AgentInstallToolCatalogEntry[];
  readonly install: (
    shortName: string,
    report: (line: string) => void,
  ) => Promise<AgentInstallSessionResult>;
}

export interface AgentSessionBashSession {
  readonly workdir: string;
  readonly profile: ShellProfile;
  readonly maxSessions: number;
  readonly defaultYieldMs: number;
  readonly maxOutputTokens: number;
  readonly bufferCapacity: number;
}

export type SessionSkillSummary = SkillSummary;

interface ActiveTurn {
  readonly abortController: AbortController;
  readonly execSessionIds: Set<number>;
  readonly pendingToolCalls: Map<string, PendingToolCall>;
  aborted: boolean;
  cancellationEventEmitted: boolean;
  cancellationPersisted: boolean;
  cancellationReason?: SessionCancellationReason;
}

interface PendingToolCall {
  readonly toolCallId: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly resources: readonly ToolResourceAccess[];
}

const SESSION_CLOSE_TIMEOUT_MS = 6_000;
const MAX_CONTEXT_RECOVERY_ATTEMPTS = 1;
const SERIALIZED_INVALID_TOOL_INPUT_PREFIX = "AI_InvalidToolInputError:";

export type SessionToolExecutionRecordView =
  | SequencedToolExecutionRecord
  | (RedactedToolExecutionRecordSummary & { readonly sequence: number });

function createActiveTurn(): ActiveTurn {
  return {
    abortController: new AbortController(),
    execSessionIds: new Set<number>(),
    pendingToolCalls: new Map<string, PendingToolCall>(),
    aborted: false,
    cancellationEventEmitted: false,
    cancellationPersisted: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolOutputMessage(value: unknown): string {
  return errorMessage(readDisplayOutput(value));
}

function toolErrorOutcomeKind(
  error: unknown,
): Exclude<
  (typeof TOOL_OUTCOME_KINDS)[keyof typeof TOOL_OUTCOME_KINDS],
  typeof TOOL_OUTCOME_KINDS.success
> {
  // AI SDK v7 serializes parse-time Tool input errors before exposing the
  // `tool-error` stream part. Match its stable machine error name, never the
  // localized/human-readable message that follows it.
  return InvalidToolInputError.isInstance(error) ||
    (typeof error === "string" && error.startsWith(SERIALIZED_INVALID_TOOL_INPUT_PREFIX))
    ? TOOL_OUTCOME_KINDS.invalidInput
    : TOOL_OUTCOME_KINDS.toolFailed;
}

function stopOnUserRejected(): StopCondition<ToolSet> {
  return ({ steps }) =>
    steps
      .at(-1)
      ?.toolResults.some(
        (result) => readToolOutcome(result.output).kind === TOOL_OUTCOME_KINDS.userRejected,
      ) ?? false;
}

function isContextWindowError(error: unknown): boolean {
  return /context[_ -]?length|context window|maximum context|token limit|too many tokens|prompt is too long|input is too long/i.test(
    errorMessage(error),
  );
}

function toSessionUsage(usage: LanguageModelUsage): SessionTokenUsage {
  const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function addOptionalTokens(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

function addUsage(acc: SessionTokenUsage, next: SessionTokenUsage): SessionTokenUsage {
  const cachedInputTokens = addOptionalTokens(acc.cachedInputTokens, next.cachedInputTokens);
  const cacheWriteTokens = addOptionalTokens(acc.cacheWriteTokens, next.cacheWriteTokens);
  const reasoningTokens = addOptionalTokens(acc.reasoningTokens, next.reasoningTokens);
  return {
    inputTokens: (acc.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (acc.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (acc.totalTokens ?? 0) + (next.totalTokens ?? 0),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function maxTokenCount(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) {
    return current;
  }
  return current === undefined ? next : Math.max(current, next);
}

function isPotentialInputEcho(candidate: string, input: string): boolean {
  const normalizedCandidate = candidate.trim();
  const normalizedInput = input.trim();
  return (
    normalizedCandidate.length > 0 &&
    normalizedInput.length > 0 &&
    normalizedInput.startsWith(normalizedCandidate)
  );
}

function resolveCancellationReason(
  current: SessionCancellationReason | undefined,
  abortReason: unknown,
): SessionCancellationReason {
  if (current !== undefined) {
    return current;
  }
  return isTurnTimeoutAbortReason(abortReason)
    ? SESSION_CANCELLATION_REASONS.timeout
    : SESSION_CANCELLATION_REASONS.runtime;
}

function stripReasoningMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [message];
    }

    const content = message.content.filter((part) => part.type !== "reasoning");
    if (content.length === 0) {
      return [];
    }
    if (content.length === message.content.length) {
      return [message];
    }
    return [{ ...message, content }];
  });
}

function markToolRole(
  target: Record<string, CapabilityToolRole>,
  tools: ToolSet,
  role: CapabilityToolRole,
): void {
  for (const id of Object.keys(tools)) {
    target[id] = role;
  }
}

function markSessionExecRoles(
  target: Record<string, CapabilityToolRole>,
  tools: ToolSet,
  registry: ToolRegistry,
): void {
  const rolesByToolName: Readonly<Record<string, CapabilityToolRole>> = {
    [EXEC_COMMAND_NAME]: CAPABILITY_TOOL_ROLES.sessionCommand,
    [EXEC_POLL_NAME]: CAPABILITY_TOOL_ROLES.sessionPoll,
    [EXEC_LIST_NAME]: CAPABILITY_TOOL_ROLES.sessionList,
  };
  for (const id of Object.keys(tools)) {
    const route = registry.resolve(id);
    const role = route ? rolesByToolName[route.toolName] : undefined;
    if (role) {
      target[id] = role;
    }
  }
}

function prependLastUserContext(
  messages: readonly ModelMessage[],
  context: string,
): ModelMessage[] {
  const copy = [...messages];
  for (let index = copy.length - 1; index >= 0; index -= 1) {
    const message = copy[index];
    if (message?.role !== "user") {
      continue;
    }
    copy[index] = {
      ...message,
      content:
        typeof message.content === "string"
          ? `${context}\n\n${message.content}`
          : [{ type: "text", text: context }, ...message.content],
    };
    break;
  }
  return copy;
}

export class AgentSession {
  readonly id: string;
  private readonly model: LanguageModelV4;
  private readonly maxSteps: number;
  private readonly messages: ModelMessage[];
  private readonly onPersist: ((messages: readonly ModelMessage[]) => void) | undefined;
  private readonly onReplace: ((messages: readonly ModelMessage[]) => void) | undefined;
  private readonly onToolExecution: ((record: ToolExecutionRecord) => void) | undefined;
  private readonly listPersistedToolExecutions:
    | ((options?: ListToolExecutionsOptions) => readonly SequencedToolExecutionRecord[])
    | undefined;
  private readonly getPersistedToolExecution:
    | ((executionId: string) => SequencedToolExecutionRecord | undefined)
    | undefined;
  private readonly listPersistedTranscriptMessages:
    | ((options?: ListTranscriptMessagesOptions) => readonly ArchivedTranscriptMessage[])
    | undefined;
  private readonly commitPersistedCompaction:
    | ((input: CommitCompactionInput) => CompactionCheckpoint)
    | undefined;
  private readonly inMemoryToolExecutions: ToolExecutionRecord[] = [];
  private readonly compactionResources = new Map<string, CompactionResource>();
  private readonly contextWindow: number | undefined;
  private readonly compaction: SessionCompactionSettings | undefined;
  private readonly turnTimeoutMs: number | undefined;
  private readonly onClose: (() => void) | undefined;
  private providerOptions: SharedV4ProviderOptions | undefined;
  private readonly onProviderOptionsChange:
    | ((providerOptions: SharedV4ProviderOptions | undefined) => void)
    | undefined;
  private readonly debugEvents: boolean;
  private readonly policy: ToolPolicy | undefined;
  private systemPrompt: string;
  private readonly explicitSystemPrompt: string | undefined;
  private capabilityContext: AgentSessionCapabilityContext;
  private readonly resolveDynamicCapabilityContext:
    | (() => CapabilityExternalDynamicContext | Promise<CapabilityExternalDynamicContext>)
    | undefined;
  private capabilityManifest: EffectiveCapabilityManifest;
  private lastCapabilityTurnContext: EffectiveCapabilityTurnContext | undefined;
  private readonly toolRoles: Record<string, CapabilityToolRole>;
  private skillSummaries: readonly SessionSkillSummary[];
  private skillLibrary: SkillLibrary | undefined;
  private skillToolBuilt = false;
  private readonly toolSourceAgentNames: Set<string>;
  private readonly gate = new ApprovalGate();
  private readonly toolCoordinator = new ToolExecutionCoordinator();
  private tools: ToolSet;
  private readonly registry: ToolRegistry;
  private readonly sessionManager: SessionManager | undefined;
  private readonly sessionManagerInstanceId = randomUUID();
  private compactionCheckpoint: CompactionCheckpoint | undefined;
  private emit: ((event: SessionEvent) => void) | undefined;
  private activeTurn: ActiveTurn | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private sessionUsage: SessionTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private lastInputTokens: number | undefined;
  private needsCompaction = false;

  constructor(options: AgentSessionOptions) {
    this.id = options.id;
    this.model = options.model;
    this.maxSteps = options.maxSteps;
    const initialMessages = options.initialMessages
      ? stripReasoningMessages(options.initialMessages)
      : [];
    this.messages = [...repairActiveToolProtocol(initialMessages).messages];
    this.onPersist = options.onPersist;
    this.onReplace = options.onReplace;
    this.onToolExecution = options.onToolExecution;
    this.listPersistedToolExecutions = options.listToolExecutions;
    this.getPersistedToolExecution = options.getToolExecution;
    this.listPersistedTranscriptMessages = options.listTranscriptMessages;
    this.commitPersistedCompaction = options.commitCompaction;
    this.compactionCheckpoint = options.initialCheckpoint;
    for (const resource of options.initialCheckpoint?.resources ?? []) {
      this.retainCompactionResource(resource);
    }
    this.contextWindow = options.contextWindow;
    this.compaction = options.compaction;
    this.turnTimeoutMs = options.turnTimeoutMs;
    this.onClose = options.onClose;
    this.providerOptions = options.providerOptions;
    this.onProviderOptionsChange = options.onProviderOptionsChange;
    this.debugEvents = options.debugEvents ?? false;
    this.policy = options.policy;
    this.explicitSystemPrompt = options.systemPrompt;
    this.resolveDynamicCapabilityContext = options.resolveDynamicCapabilityContext;
    this.skillLibrary = options.skillLibrary;
    this.skillSummaries = options.skillLibrary?.list() ?? [];
    this.toolSourceAgentNames = new Set(options.sources.map((source) => source.agentName));
    const registry = new ToolRegistry();
    const toolRoles: Record<string, CapabilityToolRole> = {};
    const transcriptTools = options.readCheckpointTranscript
      ? buildTranscriptToolset(
          options.readCheckpointTranscript,
          registry,
          this.toolCoordinator,
          `thread:${this.id}:transcript`,
        )
      : {};
    markToolRole(toolRoles, transcriptTools, CAPABILITY_TOOL_ROLES.transcriptRead);
    const skillTools = options.skillLibrary ? this.buildSkillTools(registry) : {};
    markToolRole(toolRoles, skillTools, CAPABILITY_TOOL_ROLES.skill);
    const bashCtx: BashToolContext = {
      ...(options.policy ? { policy: options.policy } : {}),
      requestApproval: (request) => this.requestApproval(request),
      emitEvent: (event) => this.emit?.(event),
      coordinator: this.toolCoordinator,
    };
    const bashClassifierDep = options.bashClassifier ? { classifier: options.bashClassifier } : {};
    const bashTools = options.bash
      ? buildBashToolset(options.bash, registry, bashCtx, bashClassifierDep)
      : {};
    markToolRole(toolRoles, bashTools, CAPABILITY_TOOL_ROLES.shell);
    if (options.bashSession) {
      this.sessionManager = new SessionManager({
        maxSessions: options.bashSession.maxSessions,
        profile: options.bashSession.profile,
        env: withCleanEnv(process.env),
        bufferCapacity: options.bashSession.bufferCapacity,
      });
    }
    const sessionExecTools =
      options.bashSession && this.sessionManager
        ? buildSessionExecToolset(
            {
              workdir: options.bashSession.workdir,
              defaultYieldMs: options.bashSession.defaultYieldMs,
              maxOutputTokens: options.bashSession.maxOutputTokens,
            },
            this.sessionManager,
            registry,
            bashCtx,
            {
              ...bashClassifierDep,
              onSessionTouched: (sessionId) => this.activeTurn?.execSessionIds.add(sessionId),
            },
          )
        : {};
    markSessionExecRoles(toolRoles, sessionExecTools, registry);
    const agentInstall = options.agentInstall;
    const agentInstallTools = agentInstall
      ? buildAgentInstallToolset(
          {
            catalog: agentInstall.catalog,
            install: async (shortName, report) => {
              const result = await agentInstall.install(shortName, report);
              if (result.outcome.ok && result.refresh) {
                this.applyAgentRefresh(result.refresh);
                return { ...result.outcome, refreshApplied: true };
              }
              return result.outcome;
            },
          },
          registry,
          {
            ...(options.policy ? { policy: options.policy } : {}),
            requestApproval: (request) => this.requestApproval(request),
            coordinator: this.toolCoordinator,
          },
        )
      : {};
    markToolRole(toolRoles, agentInstallTools, CAPABILITY_TOOL_ROLES.agentInstall);
    const built = buildAgentToolset(
      options.sources,
      {
        ...(options.policy ? { policy: options.policy } : {}),
        requestApproval: (request) => this.requestApproval(request),
        coordinator: this.toolCoordinator,
      },
      registry,
    );
    this.tools = {
      ...transcriptTools,
      ...skillTools,
      ...bashTools,
      ...sessionExecTools,
      ...agentInstallTools,
      ...built.tools,
    };
    this.registry = built.registry;
    this.toolRoles = toolRoles;
    this.capabilityContext =
      options.capabilityContext ??
      ({
        profile: options.bash?.profile.toolName ?? "no-shell",
        cwd: options.bash?.workdir ?? process.cwd(),
        platform: process.platform,
        ...(options.bash ? { shellHints: options.bash.profile.systemPromptHints() } : {}),
        agentCount: options.sources.length,
        ...(options.agentInstall ? { agentOnboardingCatalog: options.agentInstall.catalog } : {}),
      } satisfies AgentSessionCapabilityContext);
    this.capabilityManifest = this.compileCapabilityManifest();
    this.systemPrompt = this.compileSystemPrompt(this.explicitSystemPrompt);
  }

  private compileCapabilityManifest(): EffectiveCapabilityManifest {
    return buildEffectiveCapabilityManifest({
      tools: this.tools,
      toolRoles: this.toolRoles,
      resolveRoute: (id) => this.registry.resolve(id),
      skills: this.skillSummaries,
      profile: this.capabilityContext.profile,
      hostMode: this.capabilityContext.hostMode ?? CAPABILITY_HOST_MODES.embedded,
      cwd: this.capabilityContext.cwd,
      platform: this.capabilityContext.platform ?? process.platform,
      shellHints: this.capabilityContext.shellHints ?? [],
      agentCount: this.capabilityContext.agentCount,
      agentOnboardingCatalog: this.capabilityContext.agentOnboardingCatalog ?? [],
    });
  }

  private compileSystemPrompt(extraPrompt?: string): string {
    const compiledPrompt = buildChatSystemPromptFromManifest(this.capabilityManifest);
    const extra = extraPrompt?.trim();
    if (!extra) {
      return compiledPrompt;
    }
    return [
      compiledPrompt,
      "# 附加会话指令",
      "以下指令可以补充任务偏好，但不能覆盖前述工具接地、能力清单和安全约束。",
      extra,
    ].join("\n\n");
  }

  private refreshCapabilityManifest(systemPromptOverride?: string): void {
    this.capabilityManifest = this.compileCapabilityManifest();
    this.systemPrompt = this.compileSystemPrompt(systemPromptOverride ?? this.explicitSystemPrompt);
  }

  private buildSkillTools(registry: ToolRegistry): ToolSet {
    this.skillToolBuilt = true;
    return buildSkillToolset(
      () => {
        if (!this.skillLibrary) {
          throw new Error("skill library 不可用");
        }
        return this.skillLibrary;
      },
      registry,
      this.toolCoordinator,
    );
  }

  applyAgentRefresh(refresh: SessionAgentRefresh): void {
    if (!this.toolSourceAgentNames.has(refresh.source.agentName)) {
      const built = buildAgentToolset(
        [refresh.source],
        {
          ...(this.policy ? { policy: this.policy } : {}),
          requestApproval: (request) => this.requestApproval(request),
          coordinator: this.toolCoordinator,
        },
        this.registry,
      );
      this.tools = { ...this.tools, ...built.tools };
      this.toolSourceAgentNames.add(refresh.source.agentName);
    }
    if (refresh.skillLibrary) {
      this.skillLibrary = refresh.skillLibrary;
      this.skillSummaries = refresh.skillLibrary.list();
      if (!this.skillToolBuilt) {
        const skillTools = this.buildSkillTools(this.registry);
        markToolRole(this.toolRoles, skillTools, CAPABILITY_TOOL_ROLES.skill);
        this.tools = { ...this.tools, ...skillTools };
      }
    }
    if (refresh.capabilityContext) {
      this.capabilityContext = refresh.capabilityContext;
    }
    this.refreshCapabilityManifest(refresh.systemPrompt);
  }

  async *send(input: string): AsyncIterable<SessionEvent> {
    if (this.closed) {
      throw new Error("session is closed");
    }
    if (this.activeTurn) {
      throw new Error("session already has an active turn");
    }

    const queue = new AsyncEventQueue<SessionEvent>();
    this.emit = (event) => queue.push(event);
    const activeTurn = createActiveTurn();
    this.activeTurn = activeTurn;

    this.runTurn(queue, activeTurn, input).catch((error: unknown) => {
      queue.push({ type: "error", stage: "execute", message: errorMessage(error) });
      queue.close();
    });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      if (this.activeTurn === activeTurn) {
        this.abandonTurn(activeTurn);
      }
      if (this.emit !== undefined) {
        this.emit = undefined;
      }
    }
  }

  async *compact(reason: ContextCompactionReason = "manual"): AsyncIterable<SessionEvent> {
    if (this.closed) {
      throw new Error("session is closed");
    }
    if (this.activeTurn) {
      throw new Error("session already has an active turn");
    }

    const queue = new AsyncEventQueue<SessionEvent>();
    this.emit = (event) => queue.push(event);
    const activeTurn = createActiveTurn();
    this.activeTurn = activeTurn;

    this.runCompactionTurn(queue, activeTurn, reason).catch((error: unknown) => {
      queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
      queue.close();
    });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      if (this.activeTurn === activeTurn) {
        this.abandonTurn(activeTurn);
      }
      if (this.emit !== undefined) {
        this.emit = undefined;
      }
    }
  }

  private async runTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    input: string,
  ): Promise<void> {
    const turnStartedAt = Date.now();
    let turnStart: number | undefined;
    let turnTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      this.debug(queue, "turn", "start", turnStartedAt, {
        messages: this.messages.length,
        tools: Object.keys(this.tools).length,
        maxSteps: this.maxSteps,
        ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
        ...(this.lastInputTokens !== undefined ? { lastInputTokens: this.lastInputTokens } : {}),
      });
      if (this.shouldAutoCompact()) {
        this.debug(queue, "compaction", "auto requested before turn", turnStartedAt, {
          messages: this.messages.length,
          ...(this.lastInputTokens !== undefined ? { lastInputTokens: this.lastInputTokens } : {}),
        });
        try {
          await this.runCompaction(queue, "auto", activeTurn);
        } catch (error) {
          queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
          return;
        }
      }
      if (activeTurn.aborted || activeTurn.abortController.signal.aborted) {
        turnStart = this.messages.length;
        this.messages.push({ role: "user", content: input });
        this.persistCancelledTurn(queue, activeTurn, turnStart, [], turnStartedAt);
        return;
      }

      queue.push({ type: "message-start", messageId: randomUUID() });
      if (this.turnTimeoutMs !== undefined) {
        turnTimeout = setTimeout(() => {
          if (activeTurn.abortController.signal.aborted) {
            return;
          }
          activeTurn.aborted = true;
          activeTurn.cancellationReason = SESSION_CANCELLATION_REASONS.timeout;
          this.gate.abortAll("本轮运行超时");
          activeTurn.abortController.abort(TURN_TIMEOUT_ABORT_REASON);
        }, this.turnTimeoutMs);
      }
      let contextRecoveryAttempts = 0;
      const explicitSkillContext = prepareExplicitSkillContext({
        rawInput: input,
        skillSummaries: this.skillSummaries,
        skillLibrary: this.skillLibrary,
      });
      const rawUserMessage: UserModelMessage = { role: "user", content: input };
      const storedUserMessage =
        explicitSkillContext.skillNames.length > 0
          ? attachExplicitSkillCheckpoint(rawUserMessage, explicitSkillContext)
          : rawUserMessage;
      let externalDynamicContext: CapabilityExternalDynamicContext = {};
      try {
        externalDynamicContext = (await this.resolveDynamicCapabilityContext?.()) ?? {};
      } catch (error) {
        this.debug(queue, "turn", "dynamic capability context unavailable", turnStartedAt, {
          message: errorMessage(error),
        });
      }
      const capabilityTurnContext = buildEffectiveCapabilityTurnContext(this.capabilityManifest, {
        explicitSkillNames: explicitSkillContext.skillNames,
        ...(externalDynamicContext.ruleIds ? { ruleIds: externalDynamicContext.ruleIds } : {}),
        ...(externalDynamicContext.vcs ? { vcs: externalDynamicContext.vcs } : {}),
        sessions: (this.sessionManager?.list() ?? []).map((session) => ({
          sessionId: session.sessionId,
          state: session.state,
        })),
      });
      this.lastCapabilityTurnContext = capabilityTurnContext;
      const capabilityTurnReminder = buildCapabilityTurnReminder(capabilityTurnContext);
      while (true) {
        turnStart = this.messages.length;
        this.messages.push(storedUserMessage);
        const transcriptToolId = findCapabilityToolId(
          this.capabilityManifest,
          CAPABILITY_TOOL_ROLES.transcriptRead,
        );
        const checkpointReminder = this.compactionCheckpoint
          ? buildCompactionCheckpointReminder(
              this.compactionCheckpoint,
              this.sessionManagerInstanceId,
              transcriptToolId,
            )
          : undefined;
        const inferenceMessages = prependLastUserContext(
          materializeExplicitSkillCheckpoints(this.messages),
          checkpointReminder
            ? `${capabilityTurnReminder}\n\n${checkpointReminder}`
            : capabilityTurnReminder,
        );
        this.debug(queue, "model", "calling streamText", turnStartedAt, {
          messages: this.messages.length,
          tools: Object.keys(this.tools).length,
          contextRecoveryAttempts,
          ...(this.turnTimeoutMs !== undefined ? { timeoutMs: this.turnTimeoutMs } : {}),
        });
        let abortedResponseMessages: ModelMessage[] = [];
        const createStreamResult = () =>
          streamText({
            model: this.model,
            system: this.systemPrompt,
            messages: inferenceMessages,
            tools: this.tools,
            stopWhen: [stepCountIs(this.maxSteps), stopOnUserRejected()],
            toolApproval: async ({ toolCall }) => {
              await this.toolCoordinator.prepare(
                toolCall.toolCallId,
                toolCall.toolName,
                toolCall.input,
              );
              return undefined;
            },
            onLanguageModelCallStart: ({ callId }) => this.toolCoordinator.startBatch(callId),
            onLanguageModelCallEnd: ({ callId, content }) =>
              this.toolCoordinator.sealBatch(
                callId,
                content.flatMap((part) =>
                  part.type === "tool-call" &&
                  part.providerExecuted !== true &&
                  (!("invalid" in part) || part.invalid !== true)
                    ? [{ toolCallId: part.toolCallId, toolId: part.toolName }]
                    : [],
                ),
              ),
            abortSignal: activeTurn.abortController.signal,
            ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
            onError: () => undefined,
            onAbort: ({ steps }) => {
              abortedResponseMessages = steps.flatMap((step) => step.response.messages);
            },
          });
        let result: ReturnType<typeof createStreamResult>;
        try {
          result = createStreamResult();
        } catch (error) {
          if (this.isTurnAborted(activeTurn) || isTurnTimeoutAbortReason(error)) {
            activeTurn.aborted = true;
            activeTurn.cancellationReason = resolveCancellationReason(
              activeTurn.cancellationReason,
              error,
            );
            this.persistCancelledTurn(queue, activeTurn, turnStart, [], turnStartedAt);
            return;
          }
          if (!isContextWindowError(error)) {
            throw error;
          }
          this.needsCompaction = true;
          this.messages.splice(turnStart);
          const canRetry = contextRecoveryAttempts < MAX_CONTEXT_RECOVERY_ATTEMPTS;
          const compacted = canRetry
            ? await this.recoverFromContextError(queue, activeTurn)
            : false;
          if (this.isTurnAborted(activeTurn)) {
            turnStart = this.messages.length;
            this.messages.push(storedUserMessage);
            this.persistCancelledTurn(queue, activeTurn, turnStart, [], turnStartedAt);
            return;
          }
          if (compacted && canRetry) {
            contextRecoveryAttempts += 1;
            continue;
          }
          this.persistContextFailure(queue, storedUserMessage, false, false, turnStartedAt);
          queue.push({ type: "error", stage: "execute", message: errorMessage(error) });
          return;
        }
        this.debug(queue, "model", "streamText returned", turnStartedAt);

        let text = "";
        let pendingEchoText = "";
        let sawToolCall = false;
        let totalUsage: SessionTokenUsage | undefined;
        let contextInputTokens: number | undefined;
        let outputTokensPerSecond: number | undefined;
        let stepCount = 0;
        let lastStepFinishReason: string | undefined;
        let streamError: string | undefined;
        let streamContextOverflow = false;
        let userRejectionMessage: string | undefined;
        let firstPartSeen = false;
        const firstPartTimer = this.scheduleDebug(
          queue,
          "model",
          "waiting for first stream event",
          turnStartedAt,
          { messages: this.messages.length },
        );
        try {
          for await (const part of result.fullStream) {
            if (this.closed) {
              activeTurn.aborted = true;
              activeTurn.cancellationReason ??= SESSION_CANCELLATION_REASONS.runtime;
              break;
            }
            if (!firstPartSeen) {
              firstPartSeen = true;
              this.clearDebugTimer(firstPartTimer);
              this.debug(queue, "model", "first stream event", turnStartedAt, { part: part.type });
            }
            switch (part.type) {
              case "text-delta": {
                if (!sawToolCall) {
                  const candidate = pendingEchoText + part.text;
                  if (isPotentialInputEcho(candidate, explicitSkillContext.userPrompt)) {
                    pendingEchoText = candidate;
                    break;
                  }
                  if (pendingEchoText.length > 0) {
                    const delta = pendingEchoText + part.text;
                    pendingEchoText = "";
                    text += delta;
                    queue.push({ type: "text-delta", delta });
                    break;
                  }
                }
                text += part.text;
                queue.push({ type: "text-delta", delta: part.text });
                break;
              }
              case "tool-call": {
                sawToolCall = true;
                pendingEchoText = "";
                const route = this.registry.resolve(part.toolName);
                activeTurn.pendingToolCalls.set(part.toolCallId, {
                  toolCallId: part.toolCallId,
                  agentName: route?.agentName ?? part.toolName,
                  toolName: route?.toolName ?? part.toolName,
                  input: part.input,
                  resources: this.toolCoordinator.describeResources(part.toolName, part.input),
                });
                queue.push({
                  type: "tool-call",
                  toolCallId: part.toolCallId,
                  agentName: route?.agentName ?? part.toolName,
                  toolName: route?.toolName ?? part.toolName,
                  input: part.input,
                });
                break;
              }
              case "tool-result": {
                const route = this.registry.resolve(part.toolName);
                const pending = activeTurn.pendingToolCalls.get(part.toolCallId);
                const result = isNormalizedToolResult(part.output)
                  ? part.output
                  : normalizeToolResult(part.output);
                const outcome = result.outcome;
                const display = result.display;
                const record = createToolExecutionRecord({
                  toolCallId: part.toolCallId,
                  agentName: route?.agentName ?? part.toolName,
                  toolName: route?.toolName ?? part.toolName,
                  input: pending?.input,
                  result,
                });
                this.persistToolExecution(record);
                if (outcome.kind === TOOL_OUTCOME_KINDS.success && pending !== undefined) {
                  this.rememberCompactionResources(record, pending.resources);
                }
                activeTurn.pendingToolCalls.delete(part.toolCallId);
                queue.push({
                  type: "tool-result",
                  toolCallId: part.toolCallId,
                  agentName: route?.agentName ?? part.toolName,
                  toolName: route?.toolName ?? part.toolName,
                  executionId: record.id,
                  outcome,
                  display,
                  output: display,
                  isError: outcome.kind !== TOOL_OUTCOME_KINDS.success,
                });
                if (
                  !activeTurn.aborted &&
                  !activeTurn.abortController.signal.aborted &&
                  outcome.kind === TOOL_OUTCOME_KINDS.userRejected
                ) {
                  userRejectionMessage = toolOutputMessage(part.output);
                }
                break;
              }
              case "tool-error": {
                const route = this.registry.resolve(part.toolName);
                const output = toolOutputMessage(part.error);
                const result = failedToolResult(toolErrorOutcomeKind(part.error), output, {
                  raw: part.error,
                });
                const record = createToolExecutionRecord({
                  toolCallId: part.toolCallId,
                  agentName: route?.agentName ?? part.toolName,
                  toolName: route?.toolName ?? part.toolName,
                  input: activeTurn.pendingToolCalls.get(part.toolCallId)?.input,
                  result,
                });
                this.persistToolExecution(record);
                activeTurn.pendingToolCalls.delete(part.toolCallId);
                queue.push({
                  type: "tool-result",
                  toolCallId: part.toolCallId,
                  agentName: route?.agentName ?? part.toolName,
                  toolName: route?.toolName ?? part.toolName,
                  executionId: record.id,
                  outcome: result.outcome,
                  display: result.display,
                  output,
                  isError: true,
                });
                break;
              }
              case "finish-step": {
                const stepUsage = toSessionUsage(part.usage);
                contextInputTokens = maxTokenCount(contextInputTokens, stepUsage.inputTokens);
                stepCount += 1;
                lastStepFinishReason = part.finishReason;
                const stepThroughput =
                  part.performance.outputTokensPerSecond ??
                  part.performance.effectiveOutputTokensPerSecond;
                if (stepThroughput !== undefined && Number.isFinite(stepThroughput)) {
                  outputTokensPerSecond = stepThroughput;
                }
                queue.push({
                  type: "step-finish",
                  finishReason: part.finishReason,
                  usage: stepUsage,
                });
                break;
              }
              case "finish":
                if (!sawToolCall && pendingEchoText.length > 0) {
                  text += pendingEchoText;
                  queue.push({ type: "text-delta", delta: pendingEchoText });
                  pendingEchoText = "";
                }
                totalUsage = toSessionUsage(part.totalUsage);
                break;
              case "error":
                if (this.isTurnAborted(activeTurn) || isTurnTimeoutAbortReason(part.error)) {
                  activeTurn.aborted = true;
                  activeTurn.cancellationReason = resolveCancellationReason(
                    activeTurn.cancellationReason,
                    part.error,
                  );
                  break;
                }
                streamContextOverflow = isContextWindowError(part.error);
                if (streamContextOverflow) {
                  this.needsCompaction = true;
                }
                streamError = errorMessage(part.error);
                break;
              case "abort":
                activeTurn.aborted = true;
                activeTurn.cancellationReason = resolveCancellationReason(
                  activeTurn.cancellationReason,
                  part.reason,
                );
                break;
              default:
                break;
            }
          }
        } catch (error) {
          if (this.isTurnAborted(activeTurn) || isTurnTimeoutAbortReason(error)) {
            activeTurn.aborted = true;
            activeTurn.cancellationReason = resolveCancellationReason(
              activeTurn.cancellationReason,
              error,
            );
          } else {
            streamContextOverflow = isContextWindowError(error);
            if (streamContextOverflow) {
              this.needsCompaction = true;
            }
            streamError = errorMessage(error);
          }
        } finally {
          this.clearDebugTimer(firstPartTimer);
        }
        this.debug(queue, "model", "fullStream finished", turnStartedAt, {
          textChars: text.length,
        });

        if (streamError !== undefined) {
          this.messages.splice(turnStart);
          if (streamContextOverflow) {
            const retrySafe = text.length === 0 && !sawToolCall;
            const canRetry = retrySafe && contextRecoveryAttempts < MAX_CONTEXT_RECOVERY_ATTEMPTS;
            const compacted =
              canRetry || !retrySafe
                ? await this.recoverFromContextError(queue, activeTurn)
                : false;
            if (this.isTurnAborted(activeTurn)) {
              turnStart = this.messages.length;
              this.messages.push(storedUserMessage);
              this.persistCancelledTurn(queue, activeTurn, turnStart, [], turnStartedAt);
              return;
            }
            if (retrySafe && compacted && canRetry) {
              contextRecoveryAttempts += 1;
              continue;
            }
            const suffix = retrySafe
              ? ""
              : "；本次尝试已产生文本或工具活动，为避免重复副作用未自动重放";
            this.persistContextFailure(
              queue,
              storedUserMessage,
              text.length > 0,
              sawToolCall,
              turnStartedAt,
            );
            queue.push({ type: "error", stage: "execute", message: `${streamError}${suffix}` });
            return;
          }
          queue.push({ type: "error", stage: "execute", message: streamError });
          return;
        }

        if (activeTurn.aborted || activeTurn.abortController.signal.aborted) {
          activeTurn.cancellationReason = resolveCancellationReason(
            activeTurn.cancellationReason,
            activeTurn.abortController.signal.reason,
          );
          this.persistCancelledTurn(
            queue,
            activeTurn,
            turnStart,
            abortedResponseMessages,
            turnStartedAt,
          );
          return;
        }

        let responseMessages: ModelMessage[];
        this.debug(queue, "model", "awaiting response messages", turnStartedAt);
        const responseTimer = this.scheduleDebug(
          queue,
          "model",
          "still awaiting response messages",
          turnStartedAt,
        );
        try {
          const steps = await result.steps;
          responseMessages = steps.flatMap((step) => step.response.messages);
        } catch (error) {
          this.clearDebugTimer(responseTimer);
          if (this.isTurnAborted(activeTurn) || isTurnTimeoutAbortReason(error)) {
            activeTurn.aborted = true;
            activeTurn.cancellationReason = resolveCancellationReason(
              activeTurn.cancellationReason,
              error,
            );
            this.persistCancelledTurn(
              queue,
              activeTurn,
              turnStart,
              abortedResponseMessages,
              turnStartedAt,
            );
            return;
          }
          const contextOverflow = isContextWindowError(error);
          if (contextOverflow) {
            this.needsCompaction = true;
          }
          this.messages.splice(turnStart);
          if (contextOverflow) {
            const retrySafe = text.length === 0 && !sawToolCall;
            const canRetry = retrySafe && contextRecoveryAttempts < MAX_CONTEXT_RECOVERY_ATTEMPTS;
            const compacted =
              canRetry || !retrySafe
                ? await this.recoverFromContextError(queue, activeTurn)
                : false;
            if (this.isTurnAborted(activeTurn)) {
              turnStart = this.messages.length;
              this.messages.push(storedUserMessage);
              this.persistCancelledTurn(queue, activeTurn, turnStart, [], turnStartedAt);
              return;
            }
            if (retrySafe && compacted && canRetry) {
              contextRecoveryAttempts += 1;
              continue;
            }
            const suffix = retrySafe
              ? ""
              : "；本次尝试已产生文本或工具活动，为避免重复副作用未自动重放";
            this.persistContextFailure(
              queue,
              storedUserMessage,
              text.length > 0,
              sawToolCall,
              turnStartedAt,
            );
            queue.push({
              type: "error",
              stage: "execute",
              message: `${errorMessage(error)}${suffix}`,
            });
            return;
          }
          queue.push({ type: "error", stage: "execute", message: errorMessage(error) });
          return;
        } finally {
          this.clearDebugTimer(responseTimer);
        }
        this.debug(queue, "model", "response messages ready", turnStartedAt, {
          responseMessages: responseMessages.length,
        });

        if (this.isTurnAborted(activeTurn)) {
          activeTurn.cancellationReason = resolveCancellationReason(
            activeTurn.cancellationReason,
            activeTurn.abortController.signal.reason,
          );
          this.persistCancelledTurn(
            queue,
            activeTurn,
            turnStart,
            abortedResponseMessages,
            turnStartedAt,
          );
          return;
        }

        const visibleResponseMessages = stripReasoningMessages(responseMessages);
        this.messages.push(...visibleResponseMessages);
        if (userRejectionMessage !== undefined) {
          const delta = text.length === 0 ? userRejectionMessage : `\n${userRejectionMessage}`;
          text += delta;
          queue.push({ type: "text-delta", delta });
          this.messages.push({ role: "assistant", content: userRejectionMessage });
        }
        this.debug(queue, "persist", "persisting messages", turnStartedAt, {
          appendedMessages: this.messages.length - turnStart,
        });
        this.onPersist?.(this.messages.slice(turnStart));
        this.debug(queue, "persist", "messages persisted", turnStartedAt, {
          totalMessages: this.messages.length,
        });
        if (totalUsage) {
          this.sessionUsage = addUsage(this.sessionUsage, totalUsage);
        }
        const pressureInputTokens = contextInputTokens ?? totalUsage?.inputTokens;
        if (pressureInputTokens !== undefined) {
          this.lastInputTokens = pressureInputTokens;
        }
        const stoppedAtStepLimit =
          stepCount >= this.maxSteps && lastStepFinishReason === "tool-calls";
        queue.push({
          type: "message-finish",
          text,
          ...(totalUsage ? { totalUsage } : {}),
          sessionUsage: { ...this.sessionUsage },
          ...(contextInputTokens !== undefined ? { contextInputTokens } : {}),
          ...(outputTokensPerSecond !== undefined ? { outputTokensPerSecond } : {}),
          ...(stoppedAtStepLimit ? { stoppedAtStepLimit: true } : {}),
        });
        return;
      }
    } catch (error) {
      if (this.isTurnAborted(activeTurn) || isTurnTimeoutAbortReason(error)) {
        activeTurn.aborted = true;
        activeTurn.cancellationReason = resolveCancellationReason(
          activeTurn.cancellationReason,
          activeTurn.abortController.signal.reason ?? error,
        );
        if (turnStart !== undefined) {
          this.persistCancelledTurn(queue, activeTurn, turnStart, [], turnStartedAt);
        } else {
          this.emitCancellation(queue, activeTurn);
        }
        return;
      }
      if (turnStart !== undefined) {
        this.messages.splice(turnStart);
      }
      this.debug(queue, "turn", "error", turnStartedAt, { message: errorMessage(error) });
      queue.push({ type: "error", stage: "execute", message: errorMessage(error) });
    } finally {
      if (turnTimeout !== undefined) {
        clearTimeout(turnTimeout);
      }
      this.toolCoordinator.finishTurn();
      if (this.activeTurn === activeTurn) {
        this.activeTurn = undefined;
      }
      queue.close();
    }
  }

  private persistContextFailure(
    queue: AsyncEventQueue<SessionEvent>,
    userMessage: UserModelMessage,
    producedText: boolean,
    hadToolActivity: boolean,
    turnStartedAt: number,
  ): void {
    const notes = ["本轮因上下文窗口溢出而中断，未自动重放。"];
    if (producedText) {
      notes.push("本轮已产生部分文本，持久历史仅保留此中断标记。");
    }
    if (hadToolActivity) {
      notes.push("本轮已有工具活动，外部副作用可能已发生且不会自动回滚，请核对工具结果。");
    }
    const start = this.messages.length;
    this.messages.push(userMessage);
    this.messages.push({ role: "assistant", content: notes.join("") });
    this.debug(queue, "persist", "persisting context-overflow marker", turnStartedAt, {
      hadToolActivity,
      producedText,
    });
    try {
      this.onPersist?.(this.messages.slice(start));
    } catch (error) {
      this.messages.splice(start);
      queue.push({
        type: "error",
        stage: "execute",
        message: `上下文溢出记录持久化失败: ${errorMessage(error)}`,
      });
    }
  }

  private persistToolExecution(record: ToolExecutionRecord): void {
    // Durable storage is the write-ahead boundary: never acknowledge the Tool Result
    // to the session event stream if its forensic record could not be persisted.
    this.onToolExecution?.(record);
    this.inMemoryToolExecutions.push(record);
  }

  private rememberCompactionResources(
    record: ToolExecutionRecord,
    resources: readonly ToolResourceAccess[],
  ): void {
    for (const resource of resources) {
      const evidence: CompactionResource = {
        key: resource.key,
        mode: resource.mode,
        evidenceToolCallId: record.toolCallId,
        evidenceExecutionId: record.id,
      };
      this.retainCompactionResource(evidence);
    }
  }

  private retainCompactionResource(resource: CompactionResource): void {
    const existing = this.compactionResources.get(resource.key);
    const retained =
      existing === undefined ||
      resource.mode === TOOL_RESOURCE_ACCESS_MODES.write ||
      existing.mode !== TOOL_RESOURCE_ACCESS_MODES.write
        ? resource
        : existing;
    // Map#set does not refresh insertion order. Delete first so the bounded checkpoint projection
    // evicts by the latest successful touch while preserving the strongest observed write mode.
    this.compactionResources.delete(resource.key);
    this.compactionResources.set(resource.key, retained);
  }

  private requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    const decision = this.gate.request(approvalId);
    if (this.emit === undefined) {
      this.gate.resolve(approvalId, {
        approved: false,
        reason: "approval event could not be delivered",
      });
      return decision;
    }

    this.emit({
      type: "confirmation-required",
      approvalId,
      agentName: request.agentName,
      toolName: request.toolName,
      input: request.input,
      ...(request.reason ? { reason: request.reason } : {}),
    });
    return decision;
  }

  approve(approvalId: string): boolean {
    return this.gate.resolve(approvalId, { approved: true });
  }

  reject(approvalId: string, reason?: string): boolean {
    return this.gate.resolve(approvalId, { approved: false, ...(reason ? { reason } : {}) });
  }

  getMessages(): readonly ModelMessage[] {
    return stripExplicitSkillCheckpoints(this.messages);
  }

  getToolExecutions(
    options: ListToolExecutionsOptions = {},
    includeRaw = false,
  ): readonly SessionToolExecutionRecordView[] {
    const records = this.listPersistedToolExecutions
      ? this.listPersistedToolExecutions(options)
      : this.inMemoryToolExecutions
          .map((record, sequence) => ({ ...record, sequence }))
          .filter(
            (record) =>
              record.sequence > (options.afterSequence ?? -1) &&
              (options.toolCallId === undefined || record.toolCallId === options.toolCallId),
          )
          .slice(0, options.limit ?? 100);
    return includeRaw
      ? records
      : records.map((record) => ({
          ...toRedactedToolExecutionRecordSummary(record),
          sequence: record.sequence,
        }));
  }

  getToolExecution(
    executionId: string,
    includeRaw = false,
  ): SessionToolExecutionRecordView | undefined {
    const persisted = this.getPersistedToolExecution?.(executionId);
    const record =
      persisted ??
      (() => {
        const sequence = this.inMemoryToolExecutions.findIndex(
          (candidate) => candidate.id === executionId,
        );
        const candidate = this.inMemoryToolExecutions[sequence];
        return candidate ? { ...candidate, sequence } : undefined;
      })();
    if (!record || includeRaw) {
      return record;
    }
    return {
      ...toRedactedToolExecutionRecordSummary(record),
      sequence: record.sequence,
    };
  }

  getCapabilityManifest(): EffectiveCapabilityManifest {
    return structuredClone(this.capabilityManifest);
  }

  getCapabilityTurnContext(): EffectiveCapabilityTurnContext | undefined {
    return this.lastCapabilityTurnContext
      ? structuredClone(this.lastCapabilityTurnContext)
      : undefined;
  }

  getContextWindow(): number | undefined {
    return this.contextWindow;
  }

  getSessionUsage(): SessionTokenUsage {
    return { ...this.sessionUsage };
  }

  getSkillSummaries(): readonly SessionSkillSummary[] {
    return this.skillSummaries;
  }

  setProviderOptions(providerOptions: SharedV4ProviderOptions | undefined): void {
    this.providerOptions = providerOptions;
    this.onProviderOptionsChange?.(providerOptions);
  }

  private shouldAutoCompact(): boolean {
    const settings = this.compaction;
    return (
      settings !== undefined &&
      settings.enabled &&
      (this.needsCompaction ||
        (this.contextWindow !== undefined &&
          this.lastInputTokens !== undefined &&
          this.lastInputTokens / this.contextWindow >= settings.threshold))
    );
  }

  private listCompactionTranscriptEvidence(): readonly ArchivedTranscriptMessage[] {
    const list = this.listPersistedTranscriptMessages;
    if (list === undefined) {
      return [];
    }
    const entries: ArchivedTranscriptMessage[] = [];
    let afterSequence = -1;
    while (true) {
      const page = list({ afterSequence, limit: 500 });
      entries.push(...page);
      const lastSequence = page.at(-1)?.sequence;
      if (page.length < 500 || lastSequence === undefined || lastSequence <= afterSequence) {
        break;
      }
      afterSequence = lastSequence;
    }
    return entries;
  }

  private listCompactionToolEvidence(): readonly SequencedToolExecutionRecord[] {
    const list = this.listPersistedToolExecutions;
    if (list === undefined) {
      return this.inMemoryToolExecutions.map((record, sequence) => ({ ...record, sequence }));
    }
    const records: SequencedToolExecutionRecord[] = [];
    let afterSequence = -1;
    while (true) {
      const page = list({ afterSequence, limit: 500 });
      records.push(...page);
      const lastSequence = page.at(-1)?.sequence;
      if (page.length < 500 || lastSequence === undefined || lastSequence <= afterSequence) {
        break;
      }
      afterSequence = lastSequence;
    }
    return records;
  }

  private latestExplicitSkillNames(
    transcript: readonly ArchivedTranscriptMessage[],
    newGoalSourceSequence: number | undefined,
  ): readonly string[] {
    if (newGoalSourceSequence === undefined) {
      return this.compactionCheckpoint?.context.explicitSkillNames ?? [];
    }
    const goalEntry = transcript.find((entry) => entry.sequence === newGoalSourceSequence);
    return goalEntry === undefined
      ? []
      : (readExplicitSkillCheckpoint(goalEntry.message)?.snapshot.skillNames ?? []);
  }

  private currentCompactionRunningWork(): readonly CompactionRunningWork[] {
    const previousForeign = (this.compactionCheckpoint?.runningWork ?? [])
      .filter((work) => work.managerInstanceId !== this.sessionManagerInstanceId)
      .map(
        (work): CompactionRunningWork => ({
          ...work,
          recoverability: work.recoverability === "live" ? "stale" : work.recoverability,
        }),
      );
    const observedAt = new Date().toISOString();
    const current = (this.sessionManager?.list() ?? []).map(
      (session): CompactionRunningWork => ({
        managerInstanceId: this.sessionManagerInstanceId,
        sessionId: session.sessionId,
        state: session.state,
        recoverability: isTerminalSessionState(session.state) ? "unavailable" : "live",
        commandPreview: session.commandPreview,
        workdir: session.workdir,
        observedAt,
        wallTimeMs: session.wallTimeMs,
        ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
        ...(session.terminationCause !== undefined
          ? { terminationCause: session.terminationCause }
          : {}),
        ...(session.cleanupError !== undefined ? { cleanupError: session.cleanupError } : {}),
      }),
    );
    return [...previousForeign, ...current].slice(-128);
  }

  private compactionSummaryText(messages: readonly ModelMessage[]): string | undefined {
    for (const message of messages) {
      if (
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith(SUMMARY_PREFIX)
      ) {
        return message.content.slice(SUMMARY_PREFIX.length).trim();
      }
    }
    return undefined;
  }

  private buildCompactionDraft(summary: CompactionSummary): CompactionCheckpointDraftInput {
    const transcript = this.listCompactionTranscriptEvidence();
    const completeness =
      this.compactionCheckpoint?.transcript.completeness === "legacy_snapshot" ||
      transcript.some((entry) => entry.provenance === "legacy_snapshot")
        ? "legacy_snapshot"
        : "complete";
    const previousGoal = this.compactionCheckpoint?.goal;
    const transcriptGoal = findLatestRealUserGoal(transcript);
    const goal = transcriptGoal ?? previousGoal;
    const newGoalSourceSequence =
      transcriptGoal !== undefined &&
      (previousGoal === undefined || transcriptGoal.sourceSequence > previousGoal.sourceSequence)
        ? transcriptGoal.sourceSequence
        : undefined;
    const constraints = resolveActiveCompactionConstraints(
      transcript,
      this.compactionCheckpoint?.constraints ?? [],
    );
    const toolState = buildCompactionToolState(
      transcript.map((entry) => entry.message),
      this.listCompactionToolEvidence(),
      32,
      completeness,
    );
    return {
      ...(goal ? { goal } : {}),
      constraints: [...constraints],
      resources: [...this.compactionResources.values()].slice(-256),
      toolState,
      runningWork: [...this.currentCompactionRunningWork()],
      context: {
        cwd: this.capabilityManifest.dynamicContext.cwd,
        stableRuleIds: [...this.capabilityManifest.stableContext.rules],
        systemPromptSha256: createHash("sha256").update(this.systemPrompt).digest("hex"),
        skills: this.capabilityManifest.skills.map((skill) => ({
          name: skill.name,
          source: skill.source,
        })),
        explicitSkillNames: [...this.latestExplicitSkillNames(transcript, newGoalSourceSequence)],
      },
      summary,
    };
  }

  private async runCompactionTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    reason: ContextCompactionReason,
  ): Promise<void> {
    try {
      await this.runCompaction(queue, reason, activeTurn);
    } catch (error) {
      queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
    } finally {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = undefined;
      }
      queue.close();
    }
  }

  private async runCompaction(
    queue: AsyncEventQueue<SessionEvent>,
    reason: ContextCompactionReason,
    activeTurn?: ActiveTurn,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const settings = this.compaction;
    const defaultStrategy = settings?.strategy ?? "summarize";
    this.debug(queue, "compaction", "start", startedAt, {
      reason,
      messages: this.messages.length,
    });
    queue.push({ type: "compaction-start", reason });
    if (this.isTurnAborted(activeTurn)) {
      if (activeTurn !== undefined) {
        this.emitCancellation(queue, activeTurn);
      }
      return false;
    }
    if (!settings) {
      queue.push({
        type: "context-compacted",
        reason,
        strategy: defaultStrategy,
        removed: 0,
        kept: this.messages.length,
      });
      return false;
    }

    const before = this.lastInputTokens;
    let strategy = settings.strategy;
    let summary = createCompactionSummary(undefined);
    const abortSignal = activeTurn?.abortController.signal;
    let result: Awaited<ReturnType<typeof compactMessages>>;
    try {
      result = await compactMessages({
        messages: this.messages,
        strategy,
        keepRecentTurns: settings.keepRecentTurns,
        keepRecentTokens: settings.keepRecentTokens,
        model: this.model,
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (strategy === "summarize" && result.removed > 0) {
        summary = createCompactionSummary(this.compactionSummaryText(result.messages));
        if (summary.status !== "valid") {
          this.debug(queue, "compaction", "summary rejected, fallback to truncate", startedAt, {
            reason: summary.status === "fallback" ? summary.reason : "summary missing",
          });
          strategy = "truncate";
          result = await compactMessages({
            messages: this.messages,
            strategy,
            keepRecentTurns: settings.keepRecentTurns,
            keepRecentTokens: settings.keepRecentTokens,
            model: this.model,
            ...(abortSignal ? { abortSignal } : {}),
          });
        }
      }
    } catch (error) {
      if (this.isTurnAborted(activeTurn)) {
        if (activeTurn !== undefined) {
          this.emitCancellation(queue, activeTurn);
        }
        return false;
      }
      if (strategy !== "summarize") {
        throw error;
      }
      this.debug(queue, "compaction", "summarize failed, fallback to truncate", startedAt, {
        message: errorMessage(error),
      });
      summary = { status: "fallback", reason: "summary generation failed" };
      strategy = "truncate";
      result = await compactMessages({
        messages: this.messages,
        strategy,
        keepRecentTurns: settings.keepRecentTurns,
        keepRecentTokens: settings.keepRecentTokens,
        model: this.model,
        ...(abortSignal ? { abortSignal } : {}),
      });
    }

    if (this.isTurnAborted(activeTurn)) {
      if (activeTurn !== undefined) {
        this.emitCancellation(queue, activeTurn);
      }
      return false;
    }

    const progressed = result.removed > 0 || result.truncatedTools > 0;
    const activeProjection = repairActiveToolProtocol(result.messages);
    const activeMessages = [...activeProjection.messages];
    if (activeProjection.status === ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS.repaired) {
      this.debug(queue, "compaction", "repaired malformed active Tool protocol", startedAt, {
        removedToolCallIds: activeProjection.removedToolCallIds.join(","),
        removedToolResultIds: activeProjection.removedToolResultIds.join(","),
      });
    }
    let checkpoint: CompactionCheckpoint | undefined;
    if (progressed) {
      if (this.commitPersistedCompaction !== undefined) {
        checkpoint = this.commitPersistedCompaction({
          messages: activeMessages,
          draft: this.buildCompactionDraft(summary),
        });
      } else {
        this.onReplace?.(activeMessages);
      }
      this.messages.splice(0, this.messages.length, ...activeMessages);
      if (checkpoint !== undefined) {
        this.compactionCheckpoint = checkpoint;
      }
      this.lastInputTokens = undefined;
      this.needsCompaction = false;
    }

    queue.push({
      type: "context-compacted",
      reason,
      strategy,
      removed: result.removed,
      kept: result.kept,
      ...(result.truncatedTools > 0 ? { truncatedTools: result.truncatedTools } : {}),
      ...(before !== undefined ? { beforeInputTokens: before } : {}),
      ...(checkpoint !== undefined
        ? {
            checkpointId: checkpoint.id,
            checkpointGeneration: checkpoint.generation,
            checkpointSummaryStatus: checkpoint.summary.status,
          }
        : {}),
    });
    this.debug(queue, "compaction", "finish", startedAt, {
      reason,
      strategy,
      removed: result.removed,
      kept: result.kept,
      truncatedTools: result.truncatedTools,
      progressed,
    });
    return progressed;
  }

  private async recoverFromContextError(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn?: ActiveTurn,
  ): Promise<boolean> {
    if (!this.compaction?.enabled) {
      return false;
    }
    try {
      return await this.runCompaction(queue, "auto", activeTurn);
    } catch (error) {
      queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
      return false;
    }
  }

  private isTurnAborted(activeTurn: ActiveTurn | undefined): boolean {
    return activeTurn?.aborted === true || activeTurn?.abortController.signal.aborted === true;
  }

  private execSessionIds(activeTurn: ActiveTurn): readonly number[] {
    return [...activeTurn.execSessionIds].sort((left, right) => left - right);
  }

  private interruptExecSessions(activeTurn: ActiveTurn): void {
    const execSessionIds = this.execSessionIds(activeTurn);
    if (execSessionIds.length === 0) {
      return;
    }
    this.sessionManager?.interrupt(execSessionIds).catch((error: unknown) => {
      process.stderr.write(`roll chat: 中断后台会话失败: ${errorMessage(error)}\n`);
    });
  }

  private abandonTurn(activeTurn: ActiveTurn): void {
    if (
      this.closed ||
      this.activeTurn !== activeTurn ||
      activeTurn.abortController.signal.aborted
    ) {
      return;
    }
    activeTurn.aborted = true;
    activeTurn.cancellationReason ??= SESSION_CANCELLATION_REASONS.runtime;
    this.gate.abortAll("本轮事件流已停止");
    this.interruptExecSessions(activeTurn);
    activeTurn.abortController.abort(RUNTIME_CANCELLATION_ABORT_REASON);
  }

  private cancellationMessage(activeTurn: ActiveTurn): string {
    const reason = activeTurn.cancellationReason ?? SESSION_CANCELLATION_REASONS.runtime;
    const execSessionIds = this.execSessionIds(activeTurn);
    const sessionListToolId = findCapabilityToolId(
      this.capabilityManifest,
      CAPABILITY_TOOL_ROLES.sessionList,
    );
    const sessionSuffix =
      execSessionIds.length > 0
        ? `本轮触达的后台会话 session_id: ${execSessionIds.join(", ")}。`
        : "";
    const timeoutRecovery =
      execSessionIds.length === 0
        ? ""
        : this.capabilityManifest.lifecycle.hostMode === CAPABILITY_HOST_MODES.oneShot
          ? `本次 one-shot 结束时会清理当前进程内的后台会话。${sessionSuffix}不能从后续 CLI 进程找回；`
          : sessionListToolId
            ? `后台会话不会因轮超时被终止。${sessionSuffix}可在当前进程的下一轮用 ${sessionListToolId} 找回后继续轮询；`
            : `后台会话不会因轮超时被终止。${sessionSuffix}当前没有已注册的会话列表工具，无法安全给出恢复调用；`;
    switch (reason) {
      case SESSION_CANCELLATION_REASONS.user:
        return `已取消本轮；正在运行的模型或工具已收到中断请求。${sessionSuffix}已发生的外部副作用不会自动回滚。`;
      case SESSION_CANCELLATION_REASONS.timeout:
        return `本轮因运行超时${this.turnTimeoutMs !== undefined ? `（${String(this.turnTimeoutMs)}ms）` : ""}而中断；${timeoutRecovery}未返回成功 tool result 或 Exit code: 0 的操作不能视为正常完成。`;
      case SESSION_CANCELLATION_REASONS.runtime:
        return `本轮被运行时中断；${sessionSuffix}未返回成功 tool result 或 Exit code: 0 的操作状态未知。`;
    }
  }

  private emitCancellation(queue: AsyncEventQueue<SessionEvent>, activeTurn: ActiveTurn): void {
    if (activeTurn.cancellationEventEmitted) {
      return;
    }
    activeTurn.cancellationReason ??= SESSION_CANCELLATION_REASONS.runtime;
    activeTurn.cancellationEventEmitted = true;
    const execSessionIds = this.execSessionIds(activeTurn);
    queue.push({
      type: "turn-cancelled",
      reason: activeTurn.cancellationReason,
      message: this.cancellationMessage(activeTurn),
      ...(execSessionIds.length > 0 ? { execSessionIds } : {}),
    });
  }

  private persistCancelledTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    turnStart: number,
    completedResponseMessages: readonly ModelMessage[],
    turnStartedAt: number,
  ): void {
    this.persistPendingToolCancellations(activeTurn);
    if (this.closed) {
      this.messages.splice(turnStart);
      activeTurn.cancellationPersisted = true;
      this.emitCancellation(queue, activeTurn);
      return;
    }
    if (!activeTurn.cancellationPersisted) {
      this.messages.splice(turnStart + 1);
      this.messages.push(...stripReasoningMessages(completedResponseMessages));
      this.messages.push({ role: "assistant", content: this.cancellationMessage(activeTurn) });
      activeTurn.cancellationPersisted = true;
      this.debug(queue, "persist", "persisting cancelled turn", turnStartedAt, {
        appendedMessages: this.messages.length - turnStart,
      });
      this.onPersist?.(this.messages.slice(turnStart));
    }
    this.emitCancellation(queue, activeTurn);
  }

  private persistPendingToolCancellations(activeTurn: ActiveTurn): void {
    const cancellationReason =
      activeTurn.cancellationReason ?? SESSION_CANCELLATION_REASONS.runtime;
    for (const pending of activeTurn.pendingToolCalls.values()) {
      const display = `工具调用因本轮 ${cancellationReason} 中断而取消；外部副作用状态未知`;
      const result = failedToolResult(TOOL_OUTCOME_KINDS.cancelled, display, {
        raw: {
          cancellationReason,
          abortReason: errorMessage(activeTurn.abortController.signal.reason),
        },
        reason: cancellationReason,
      });
      this.persistToolExecution(
        createToolExecutionRecord({
          toolCallId: pending.toolCallId,
          agentName: pending.agentName,
          toolName: pending.toolName,
          input: pending.input,
          result,
        }),
      );
      activeTurn.pendingToolCalls.delete(pending.toolCallId);
    }
  }

  cancel(): boolean {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return false;
    }
    activeTurn.aborted = true;
    activeTurn.cancellationReason = SESSION_CANCELLATION_REASONS.user;
    this.gate.abortAll("用户取消本轮");
    this.interruptExecSessions(activeTurn);
    activeTurn.abortController.abort(USER_CANCELLATION_ABORT_REASON);
    return true;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    const activeTurn = this.activeTurn;
    if (activeTurn) {
      activeTurn.aborted = true;
      activeTurn.cancellationReason ??= SESSION_CANCELLATION_REASONS.runtime;
      this.gate.abortAll();
      activeTurn.abortController.abort(RUNTIME_CANCELLATION_ABORT_REASON);
    }

    this.closePromise = (async () => {
      const managerCleanup = (this.sessionManager?.close() ?? Promise.resolve([])).then(
        (results) => {
          for (const result of results) {
            if (result.cleanupError !== undefined) {
              process.stderr.write(
                `roll chat: 后台会话 ${String(result.sessionId)} 清理失败: ${result.cleanupError}\n`,
              );
            }
          }
        },
        (error: unknown) => {
          process.stderr.write(`roll chat: 会话 ${this.id} 后台清理失败: ${errorMessage(error)}\n`);
        },
      );
      const completed = await waitForPromiseSettlement(managerCleanup, SESSION_CLOSE_TIMEOUT_MS);
      if (!completed) {
        process.stderr.write(
          `roll chat: 会话 ${this.id} 在 ${String(SESSION_CLOSE_TIMEOUT_MS)}ms 内未完成全部关闭步骤\n`,
        );
      }
      try {
        this.onClose?.();
      } catch (error) {
        process.stderr.write(`roll chat: 会话 ${this.id} 关闭回调失败: ${errorMessage(error)}\n`);
      }
    })();
    return this.closePromise;
  }

  abort(): void {
    // Backward-compatible fire-and-forget teardown. Turn abandonment uses abandonTurn() so the
    // owning ConversationEngine can keep this session alive for the next user request.
    this.close().catch((error: unknown) => {
      process.stderr.write(`roll chat: 会话 ${this.id} 关闭失败: ${errorMessage(error)}\n`);
    });
  }

  private debug(
    queue: AsyncEventQueue<SessionEvent>,
    stage: SessionDebugStage,
    message: string,
    startedAt?: number,
    data?: SessionDebugData,
  ): void {
    if (!this.debugEvents) {
      return;
    }
    queue.push({
      type: "debug",
      stage,
      message,
      ...(startedAt !== undefined ? { elapsedMs: Date.now() - startedAt } : {}),
      ...(data !== undefined ? { data } : {}),
    });
  }

  private scheduleDebug(
    queue: AsyncEventQueue<SessionEvent>,
    stage: SessionDebugStage,
    message: string,
    startedAt: number,
    data?: SessionDebugData,
  ): ReturnType<typeof setTimeout> | undefined {
    if (!this.debugEvents) {
      return undefined;
    }
    return setTimeout(() => {
      this.debug(queue, stage, message, startedAt, data);
    }, 5_000);
  }

  private clearDebugTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
