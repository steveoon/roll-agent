import { describeAppOutput } from "@roll-agent/protocol";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { waitForPromiseSettlement } from "../bounded-wait.ts";
import { buildSessionModelRequest } from "./model-request.ts";
import { ModelRecoveryBudget, type ModelTurnRecovery } from "./model-recovery.ts";
import {
  ContextMaintenanceRequired,
  RequestBudgetTracker,
  type RequestBudgetSnapshot,
} from "./request-budget.ts";
import type { ContextWindowSource } from "./context-window.ts";
import {
  buildUserMessageContent,
  normalizeSessionSendInput,
  type NormalizedSessionSendInput,
  type SessionSendInput,
} from "./session-attachments.ts";
import {
  stepCountIs,
  streamText,
  wrapLanguageModel,
  InvalidToolInputError,
  NoOutputGeneratedError,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type UserModelMessage,
} from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { UserInputForm, UserInputResult } from "@roll-agent/protocol";
import type { ObservationRetentionDeclaration } from "@roll-agent/protocol/observation-retention";
import type { SkillLibrary, SkillSummary } from "@roll-agent/core/skills/library";
import type { JsonSchemaRefIssue } from "@roll-agent/core/tool-runtime/json-schema-refs";
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
import { buildScheduleToolset, type ScheduleToolDeps } from "../tool-bridge/schedule-tool.ts";
import { createInvalidScheduleRetryGuard } from "../tool-bridge/invalid-schedule-retry.ts";
import {
  buildFileToolset,
  type SessionFileToolsSettings,
} from "../tool-bridge/file-tools/index.ts";
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
import { isTerminalSessionState } from "../bash/session/types.ts";
import { withCleanEnv } from "../bash/clean-env.ts";
import type { ShellProfile } from "../bash/profile.ts";
import type { CommandClassifier } from "../types/command-classification.ts";
import {
  RUNTIME_CANCELLATION_ABORT_REASON,
  SESSION_CANCELLATION_REASONS,
  TURN_TIMEOUT_ABORT_REASON,
  USER_CANCELLATION_ABORT_REASON,
  createTurnCancellationMessage,
  isTurnTimeoutAbortReason,
  type SessionCancellationReason,
} from "../types/cancellation.ts";
import { ToolRegistry } from "../tool-bridge/naming.ts";
import {
  TOOL_CANCELLATION_EXECUTION_STATES,
  TOOL_OUTCOME_KINDS,
  createToolResult,
  failedToolResult,
  isNormalizedToolResult,
  normalizeToolResult,
  readDisplayOutput,
  readToolOutcome,
  type ToolModelOutput,
} from "../tool-bridge/normalize-result.ts";
import { friendlyInvalidToolInputMessage } from "../tool-bridge/bounded-param.ts";
import {
  createToolExecutionRecord,
  toRedactedToolExecutionRecordSummary,
  type RedactedToolExecutionRecordSummary,
  type ToolExecutionRecord,
  type ToolExecutionRecordId,
} from "../tool-bridge/tool-execution-record.ts";
import type {
  AppendMessagesOptions,
  CommitCompactionInput,
  ListToolExecutionsOptions,
  ListTranscriptMessagesOptions,
  SequencedToolExecutionRecord,
  ToolExecutionContextRepresentation,
} from "../store/thread-store.ts";
import {
  ToolExecutionCoordinator,
  type ToolCallOccurrence,
  type ToolResourceAccess,
} from "../tool-bridge/tool-execution-coordinator.ts";
import { ApprovalGate, type ApprovalDecision } from "../approval/approval-gate.ts";
import { SessionApprovalMemory } from "../approval/approval-memory.ts";
import {
  compactMessages,
  estimateMessagesTokens,
  estimateTextTokens,
  isCompactionSummaryAcknowledgement,
  readCompactionSummaryPayload,
} from "./compactor.ts";
import { AsyncEventQueue } from "./event-queue.ts";
import { ToolInputActivityTracker } from "./tool-input-activity.ts";
import {
  projectTurnInputSkillCheckpoint,
  turnInputSkillCheckpointSchema,
  type AcceptedTurnInput,
  type TurnInputSkillCheckpoint,
} from "../store/turn-input.ts";
import type { ExplicitSkillCheckpointV1 } from "./explicit-skill-context.ts";
import {
  attachExplicitSkillCheckpoint,
  prepareExplicitSkillContext,
  readExplicitSkillCheckpoint,
  stripExplicitSkillCheckpoints,
} from "./explicit-skill-context.ts";
import {
  createCancelledTurnRecoveryMessage,
  createToolLedgerGapRecoveryMessage,
  stripCancelledTurnRecoveryMessages,
} from "./cancelled-turn-recovery.ts";
import {
  CAPABILITY_HOST_MODES,
  CAPABILITY_TOOL_ROLES,
  buildEffectiveCapabilityTurnContext,
  buildEffectiveCapabilityManifest,
  findCapabilityToolId,
  isProcessBoundHostMode,
  type CapabilityAgentOnboardingCatalogEntry,
  type CapabilityExternalDynamicContext,
  type CapabilityHostMode,
  type CapabilityToolRole,
  type EffectiveCapabilityTurnContext,
  type EffectiveCapabilityManifest,
} from "./capability-manifest.ts";
import { buildCapabilityTurnReminder, buildChatSystemPromptFromManifest } from "./system-prompt.ts";
import { threadDerivedFromSchema, type ThreadDerivedFrom } from "../store/thread-origin.ts";
import type {
  WorkspaceInstructions,
  WorkspaceInstructionsSource,
} from "./workspace-instructions.ts";
import {
  buildCompactionCheckpointReminder,
  buildCompactionToolState,
  createSummaryCheckpoint,
  TRANSCRIPT_MESSAGE_PROVENANCES,
  type ArchivedTranscriptMessage,
  type CompactionCheckpoint,
} from "./compaction-checkpoint.ts";
import {
  ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS,
  repairActiveToolProtocol,
} from "./tool-protocol-repair.ts";
import { buildTranscriptToolset, type TranscriptReader } from "../tool-bridge/transcript-tool.ts";
import {
  buildObservationRecallToolset,
  type ObservationRecallInput,
} from "../tool-bridge/observation-recall-tool.ts";
import { readObservationPage } from "./observation-readback.ts";
import {
  canonicalObservationOutput,
  projectObservationMessages,
  restoreCanonicalObservationOutputs,
} from "./observation-projection.ts";
import {
  UserInputInteractionManager,
  type SessionUserInputRequestId,
} from "../interaction/user-input-interaction-manager.ts";
import { buildUserInputTool } from "../tool-bridge/user-input-tool.ts";

export interface SessionCompactionSettings {
  readonly enabled: boolean;
  readonly strategy: ContextCompactionStrategy;
  /** Total provider budget for schema-constrained checkpoint generation. */
  readonly timeoutMs?: number;
  /** AI SDK output budget for the structured checkpoint; reasoning accounting varies by provider. */
  readonly maxOutputTokens?: number;
  readonly threshold: number;
  readonly keepRecentTurns: number;
  readonly keepRecentTokens: number;
}

export type ToolSchemaPolicy = (issues: readonly JsonSchemaRefIssue[]) => boolean;

export interface SessionToolExclusion {
  readonly toolId: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly issues: readonly JsonSchemaRefIssue[];
}

export interface SessionModelSwitch {
  readonly model: LanguageModelV4;
  readonly modelRecovery?: ModelTurnRecovery;
  readonly contextWindow?: number;
  readonly contextWindowSource?: ContextWindowSource;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly structuredOutputProviderOptions?: SharedV4ProviderOptions;
  readonly structuredOutputReasoning?: NonNullable<LanguageModelV4CallOptions["reasoning"]>;
  readonly toolSchemaPolicy?: ToolSchemaPolicy;
}

export interface AgentSessionOptions {
  readonly id: string;
  readonly model: LanguageModelV4;
  readonly modelRecovery?: ModelTurnRecovery;
  readonly sources: readonly AgentToolSource[];
  readonly maxSteps: number;
  readonly policy?: ToolPolicy;
  readonly initialMessages?: readonly ModelMessage[];
  readonly onPersist?: (messages: readonly ModelMessage[], options?: AppendMessagesOptions) => void;
  readonly onAcceptInput?: (inputId: string, message: UserModelMessage) => AcceptedTurnInput;
  readonly onRecordInputSkillCheckpoint?: (
    inputId: string,
    checkpoint: ExplicitSkillCheckpointV1,
  ) => void;
  readonly getInputSkillCheckpoint?: (
    transcriptSequence: number,
  ) => TurnInputSkillCheckpoint | undefined;
  readonly onReplace?: (messages: readonly ModelMessage[]) => void;
  readonly onToolExecution?: (record: ToolExecutionRecord) => void;
  readonly listToolExecutions?: (
    options?: ListToolExecutionsOptions,
  ) => readonly SequencedToolExecutionRecord[];
  readonly getToolExecution?: (executionId: string) => SequencedToolExecutionRecord | undefined;
  readonly recoverUncoveredToolExecutions?: () => readonly ModelMessage[];
  readonly initialCheckpoint?: CompactionCheckpoint;
  /** Persisted lineage rendered only in the model's system context, never user history. */
  readonly derivedFrom?: ThreadDerivedFrom;
  readonly listTranscriptMessages?: (
    options?: ListTranscriptMessagesOptions,
  ) => readonly ArchivedTranscriptMessage[];
  readonly commitCompaction?: (input: CommitCompactionInput) => CompactionCheckpoint;
  readonly readCheckpointTranscript?: TranscriptReader;
  readonly contextWindow?: number;
  readonly contextWindowSource?: ContextWindowSource;
  readonly compaction?: SessionCompactionSettings;
  readonly turnTimeoutMs?: number;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly structuredOutputProviderOptions?: SharedV4ProviderOptions;
  readonly structuredOutputReasoning?: NonNullable<LanguageModelV4CallOptions["reasoning"]>;
  /** `setProviderOptions()` 生效后触发；ConversationEngine 用它同步子 Agent Sampling。 */
  readonly onProviderOptionsChange?: (providerOptions: SharedV4ProviderOptions | undefined) => void;
  readonly toolSchemaPolicy?: ToolSchemaPolicy;
  readonly onToolExcluded?: (exclusion: SessionToolExclusion) => void;
  readonly debugEvents?: boolean;
  /**
   * 追加到 capability-driven 基础 prompt 之后的会话指令。
   * 保留旧字段名以兼容调用方；它不能替换工具接地与能力清单。
   */
  readonly systemPrompt?: string;
  readonly capabilityContext?: AgentSessionCapabilityContext;
  readonly resolveDynamicCapabilityContext?: (
    abortSignal: AbortSignal,
  ) => CapabilityExternalDynamicContext | Promise<CapabilityExternalDynamicContext>;
  readonly skillLibrary?: SkillLibrary;
  readonly workspaceInstructions?: WorkspaceInstructionsSource;
  readonly fileTools?: SessionFileToolsSettings;
  readonly bash?: SessionBashSettings;
  readonly bashClassifier?: CommandClassifier;
  readonly bashSession?: AgentSessionBashSession;
  readonly agentInstall?: AgentSessionAgentInstall;
  readonly schedules?: ScheduleToolDeps;
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
  readonly env?: NodeJS.ProcessEnv;
  readonly onCommandSpawn?: (child: ChildProcess) => void;
}

export type SessionSkillSummary = SkillSummary;

interface ActiveTurn {
  readonly inputId: string;
  readonly abortController: AbortController;
  readonly execSessionIds: Set<number>;
  readonly pendingToolCalls: Map<string, PendingToolCall>;
  readonly completedStepResponses: Map<string, readonly ModelMessage[]>;
  readonly canonicalObservationOutputs: Map<string, ToolModelOutput>;
  readonly persistedStepKeys: Set<string>;
  readonly toolExecutions: ToolExecutionRecord[];
  expiresAt?: string;
  userMessagePersisted: boolean;
  hadPotentialSideEffects: boolean;
  aborted: boolean;
  cancellationActivity?: TurnCancellationActivity;
  cancellationEventEmitted: boolean;
  cancellationPersistenceAttempted: boolean;
  cancellationPersisted: boolean;
  cancellationReason?: SessionCancellationReason;
  pausedForContextPressure: boolean;
  contextPressureContinuations: number;
  completedStepCount: number;
  userRejected: boolean;
}

interface PendingToolCall {
  readonly toolCallId: string;
  readonly executionOccurrence: ToolCallOccurrence;
  readonly agentName: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly potentialSideEffect: boolean;
  readonly resources: readonly ToolResourceAccess[];
}

interface TurnCancellationActivity {
  readonly execSessionIds: readonly number[];
  readonly hadCompletedProgress: boolean;
  readonly hadInFlightWork: boolean;
  readonly hadPotentialSideEffects: boolean;
}

const SESSION_CLOSE_TIMEOUT_MS = 6_000;
const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_CONTEXT_RECOVERY_ATTEMPTS = 1;
const INTERRUPTED_STEP_POLICIES = {
  keepRaw: "keep-raw",
  ledgerOnly: "ledger-only",
} as const;
type InterruptedStepPolicy =
  (typeof INTERRUPTED_STEP_POLICIES)[keyof typeof INTERRUPTED_STEP_POLICIES];
const INTERRUPTED_TURN_RECOVERY_POLICY =
  "这份恢复记录只描述上一轮的权威历史事实，不授权继续或重试旧任务。下一轮必须以最新真实用户消息的目标和约束为准；如果用户换题、放弃旧任务或禁止工具，不得为了恢复旧任务检查或调用工具。executionState=not_executed 表示工具确定未执行，无需检查；executionState=outcome_unknown 只允许在最新用户明确要求继续或核对上一任务时先检查，检查不等于重试。";
const SERIALIZED_INVALID_TOOL_INPUT_PREFIX = "AI_InvalidToolInputError:";

export type SessionToolExecutionRecordView =
  | SequencedToolExecutionRecord
  | (RedactedToolExecutionRecordSummary & { readonly sequence: number });

function createActiveTurn(): ActiveTurn {
  return {
    inputId: randomUUID(),
    abortController: new AbortController(),
    execSessionIds: new Set<number>(),
    pendingToolCalls: new Map<string, PendingToolCall>(),
    completedStepResponses: new Map<string, readonly ModelMessage[]>(),
    canonicalObservationOutputs: new Map<string, ToolModelOutput>(),
    persistedStepKeys: new Set<string>(),
    toolExecutions: [],
    userMessagePersisted: false,
    hadPotentialSideEffects: false,
    aborted: false,
    cancellationEventEmitted: false,
    cancellationPersistenceAttempted: false,
    cancellationPersisted: false,
    pausedForContextPressure: false,
    contextPressureContinuations: 0,
    completedStepCount: 0,
    userRejected: false,
  };
}

interface CompletedModelStep {
  readonly callId: string;
  readonly stepNumber: number;
  readonly response: { readonly messages: readonly ModelMessage[] };
}

function rememberCompletedStep(activeTurn: ActiveTurn, step: CompletedModelStep): ModelMessage[] {
  const key = `${step.callId}:${String(step.stepNumber)}`;
  const remembered = activeTurn.completedStepResponses.get(key);
  if (remembered) return [...remembered];
  const canonical = restoreCanonicalObservationOutputs(
    step.response.messages,
    activeTurn.canonicalObservationOutputs,
  );
  activeTurn.completedStepResponses.set(key, canonical);
  return canonical;
}

function canonicalMessagesForSteps(
  activeTurn: ActiveTurn,
  steps: readonly CompletedModelStep[],
): ModelMessage[] {
  return steps.flatMap(
    (step) =>
      activeTurn.completedStepResponses.get(`${step.callId}:${String(step.stepNumber)}`) ??
      restoreCanonicalObservationOutputs(
        step.response.messages,
        activeTurn.canonicalObservationOutputs,
      ),
  );
}

function completedStepMessages(activeTurn: ActiveTurn): ModelMessage[] {
  return [...activeTurn.completedStepResponses.values()].flatMap((messages) => [...messages]);
}

function unpersistedStepMessages(activeTurn: ActiveTurn): ModelMessage[] {
  return [...activeTurn.completedStepResponses.entries()]
    .filter(([key]) => !activeTurn.persistedStepKeys.has(key))
    .flatMap(([, messages]) => [...messages]);
}

function persistedStepMessages(activeTurn: ActiveTurn): ModelMessage[] {
  return [...activeTurn.completedStepResponses.entries()]
    .filter(([key]) => activeTurn.persistedStepKeys.has(key))
    .flatMap(([, messages]) => [...messages]);
}

function markTurnSegmentPersisted(activeTurn: ActiveTurn): void {
  for (const key of activeTurn.completedStepResponses.keys()) {
    activeTurn.persistedStepKeys.add(key);
  }
  activeTurn.userMessagePersisted = true;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    const serialized = safeJsonStringify(error);
    if (serialized !== undefined && serialized !== "{}") {
      return serialized;
    }
  }
  return String(error);
}

function safeJsonStringify(value: object): string | undefined {
  try {
    return JSON.stringify(value) ?? undefined;
  } catch {
    return undefined;
  }
}

function isDerivedCompactionReminderMessage(message: ModelMessage): boolean {
  return (
    (message.role === "user" &&
      typeof message.content === "string" &&
      readCompactionSummaryPayload(message.content) !== undefined) ||
    (message.role === "assistant" && isCompactionSummaryAcknowledgement(message.content))
  );
}

function awaitAbortable<T>(value: T | PromiseLike<T>, abortSignal: AbortSignal): Promise<T> {
  if (abortSignal.aborted) {
    return Promise.reject(abortSignal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => settle(() => reject(abortSignal.reason));

    abortSignal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (resolved) => settle(() => resolve(resolved)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
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

export class AgentSession {
  readonly id: string;
  private model: LanguageModelV4;
  private modelRecovery: ModelTurnRecovery | undefined;
  private readonly maxSteps: number;
  private readonly messages: ModelMessage[];
  private readonly onPersist:
    | ((messages: readonly ModelMessage[], options?: AppendMessagesOptions) => void)
    | undefined;
  private readonly onReplace: ((messages: readonly ModelMessage[]) => void) | undefined;
  private readonly onToolExecution: ((record: ToolExecutionRecord) => void) | undefined;
  private readonly listPersistedToolExecutions:
    | ((options?: ListToolExecutionsOptions) => readonly SequencedToolExecutionRecord[])
    | undefined;
  private readonly getPersistedToolExecution:
    | ((executionId: string) => SequencedToolExecutionRecord | undefined)
    | undefined;
  private readonly recoverPersistedToolExecutionContext:
    | (() => readonly ModelMessage[])
    | undefined;
  private readonly listPersistedTranscriptMessages:
    | ((options?: ListTranscriptMessagesOptions) => readonly ArchivedTranscriptMessage[])
    | undefined;
  private readonly commitPersistedCompaction:
    | ((input: CommitCompactionInput) => CompactionCheckpoint)
    | undefined;
  private readonly inMemoryToolExecutions: ToolExecutionRecord[] = [];
  private readonly uncoveredToolExecutions = new Map<ToolExecutionRecordId, ToolExecutionRecord>();
  private readonly inMemoryTranscript: ArchivedTranscriptMessage[] = [];
  private contextWindow: number | undefined;
  private readonly compaction: SessionCompactionSettings | undefined;
  private readonly turnTimeoutMs: number | undefined;
  private readonly onClose: (() => void) | undefined;
  private providerOptions: SharedV4ProviderOptions | undefined;
  private structuredOutputProviderOptions: SharedV4ProviderOptions | undefined;
  private structuredOutputReasoning:
    | NonNullable<LanguageModelV4CallOptions["reasoning"]>
    | undefined;
  private readonly onProviderOptionsChange:
    | ((providerOptions: SharedV4ProviderOptions | undefined) => void)
    | undefined;
  private readonly debugEvents: boolean;
  private readonly policy: ToolPolicy | undefined;
  private systemPrompt: string;
  private readonly explicitSystemPrompt: string | undefined;
  private readonly derivedFrom: ThreadDerivedFrom | undefined;
  private lastExtraPrompt: string | undefined;
  private readonly workspaceInstructions: WorkspaceInstructionsSource | undefined;
  private appliedWorkspaceInstructions: WorkspaceInstructions | undefined;
  private capabilityContext: AgentSessionCapabilityContext;
  private readonly resolveDynamicCapabilityContext:
    | NonNullable<AgentSessionOptions["resolveDynamicCapabilityContext"]>
    | undefined;
  private capabilityManifest: EffectiveCapabilityManifest;
  private lastCapabilityTurnContext: EffectiveCapabilityTurnContext | undefined;
  private readonly toolRoles: Record<string, CapabilityToolRole>;
  private skillSummaries: readonly SessionSkillSummary[];
  private skillLibrary: SkillLibrary | undefined;
  private skillToolBuilt = false;
  private readonly toolSourceAgentNames: Set<string>;
  private toolSchemaPolicy: ToolSchemaPolicy | undefined;
  private readonly onToolExcluded: ((exclusion: SessionToolExclusion) => void) | undefined;
  private readonly agentToolSchemaIssues = new Map<string, readonly JsonSchemaRefIssue[]>();
  private excludedToolIds: ReadonlySet<string> = new Set();
  private readonly gate = new ApprovalGate();
  private readonly userInputInteractions = new UserInputInteractionManager();
  private readonly onAcceptInput: AgentSessionOptions["onAcceptInput"];
  private readonly onRecordInputSkillCheckpoint: AgentSessionOptions["onRecordInputSkillCheckpoint"];
  private readonly getInputSkillCheckpoint: AgentSessionOptions["getInputSkillCheckpoint"];
  private readonly inputSkillCheckpoints = new Map<number, TurnInputSkillCheckpoint>();
  private readonly toolCoordinator = new ToolExecutionCoordinator();
  private tools: ToolSet;
  private readonly registry: ToolRegistry;
  private observationRecallToolId: string | undefined;
  private readonly observationRetentionByToolId = new Map<
    string,
    ObservationRetentionDeclaration
  >();
  private readonly observationResultIds = new Map<string, string | undefined>();
  private readonly ambiguousObservationCallIds = new Set<string>();
  private readonly userInputToolId: string;
  private readonly userInputTool: ToolSet;
  private userInputAvailable = false;
  private readonly sessionManager: SessionManager | undefined;
  private readonly sessionManagerInstanceId = randomUUID();
  private compactionCheckpoint: CompactionCheckpoint | undefined;
  private emit: ((event: SessionEvent) => void) | undefined;
  private activeTurn: ActiveTurn | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private sessionUsage: SessionTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private lastInputTokens: number | undefined;
  private measuredProjectedTokens: number | undefined;
  private promptOverhead: number | undefined;
  private requestBudgets = new RequestBudgetTracker();
  private contextWindowSource: ContextWindowSource | undefined;

  constructor(options: AgentSessionOptions) {
    this.id = options.id;
    this.model = options.model;
    this.modelRecovery = options.modelRecovery;
    this.contextWindowSource = options.contextWindowSource;
    this.maxSteps = options.maxSteps;
    const initialMessages = options.initialMessages
      ? stripReasoningMessages(options.initialMessages)
      : [];
    this.messages = [...repairActiveToolProtocol(initialMessages).messages];
    this.onPersist = options.onPersist;
    this.onAcceptInput = options.onAcceptInput;
    this.onRecordInputSkillCheckpoint = options.onRecordInputSkillCheckpoint;
    this.getInputSkillCheckpoint = options.getInputSkillCheckpoint;
    this.onReplace = options.onReplace;
    this.onToolExecution = options.onToolExecution;
    this.listPersistedToolExecutions = options.listToolExecutions;
    this.getPersistedToolExecution = options.getToolExecution;
    this.recoverPersistedToolExecutionContext = options.recoverUncoveredToolExecutions;
    this.listPersistedTranscriptMessages = options.listTranscriptMessages;
    this.commitPersistedCompaction = options.commitCompaction;
    this.compactionCheckpoint = options.initialCheckpoint;
    let initialTranscriptSequence =
      (options.initialCheckpoint?.transcript.messages.throughSequence ?? -1) + 1;
    for (const message of this.messages) {
      if (isDerivedCompactionReminderMessage(message)) {
        continue;
      }
      this.inMemoryTranscript.push({
        sequence: initialTranscriptSequence,
        provenance: TRANSCRIPT_MESSAGE_PROVENANCES[0],
        createdAt: new Date(0).toISOString(),
        message,
      });
      initialTranscriptSequence += 1;
    }
    this.contextWindow = options.contextWindow;
    this.compaction = options.compaction;
    this.turnTimeoutMs = options.turnTimeoutMs;
    this.onClose = options.onClose;
    this.providerOptions = options.providerOptions;
    this.structuredOutputProviderOptions = options.structuredOutputProviderOptions;
    this.structuredOutputReasoning = options.structuredOutputReasoning;
    this.onProviderOptionsChange = options.onProviderOptionsChange;
    this.debugEvents = options.debugEvents ?? false;
    this.policy = options.policy;
    this.explicitSystemPrompt = options.systemPrompt;
    this.derivedFrom =
      options.derivedFrom === undefined
        ? undefined
        : threadDerivedFromSchema.parse(options.derivedFrom);
    this.workspaceInstructions = options.workspaceInstructions;
    this.resolveDynamicCapabilityContext = options.resolveDynamicCapabilityContext;
    this.skillLibrary = options.skillLibrary;
    this.skillSummaries = options.skillLibrary?.list() ?? [];
    this.toolSourceAgentNames = new Set(options.sources.map((source) => source.agentName));
    this.toolSchemaPolicy = options.toolSchemaPolicy;
    this.onToolExcluded = options.onToolExcluded;
    const registry = new ToolRegistry();
    const toolRoles: Record<string, CapabilityToolRole> = {};
    const userInputTool = buildUserInputTool(
      {
        sessionId: this.id,
        isAvailable: () => this.userInputAvailable,
        request: (form, abortSignal) => this.requestUserInput(form, abortSignal),
      },
      registry,
      this.toolCoordinator,
    );
    this.userInputToolId = userInputTool.id;
    this.userInputTool = userInputTool.tools;
    markToolRole(toolRoles, userInputTool.tools, CAPABILITY_TOOL_ROLES.userInput);
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
    const fileApprovalMemory = new SessionApprovalMemory();
    const fileToolset = options.fileTools
      ? buildFileToolset(options.fileTools, registry, {
          ...(options.policy ? { policy: options.policy } : {}),
          requestApproval: (request) => this.requestApproval(request),
          coordinator: this.toolCoordinator,
          approvalMemory: fileApprovalMemory,
        })
      : undefined;
    if (fileToolset) {
      markToolRole(toolRoles, fileToolset.readTools, CAPABILITY_TOOL_ROLES.fileRead);
      markToolRole(toolRoles, fileToolset.editTools, CAPABILITY_TOOL_ROLES.fileEdit);
      markToolRole(toolRoles, fileToolset.verifyTools, CAPABILITY_TOOL_ROLES.fileVerify);
    }
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
        env: withCleanEnv(options.bashSession.env ?? process.env),
        bufferCapacity: options.bashSession.bufferCapacity,
        ...(options.bashSession.onCommandSpawn
          ? { onSpawn: options.bashSession.onCommandSpawn }
          : {}),
      });
    }
    const sessionExecTools =
      options.bashSession && this.sessionManager
        ? buildSessionExecToolset(
            {
              workdir: options.bashSession.workdir,
              defaultYieldMs: options.bashSession.defaultYieldMs,
              maxOutputTokens: options.bashSession.maxOutputTokens,
              ...(options.bashSession.env ? { env: options.bashSession.env } : {}),
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
    const scheduleToolset = options.schedules
      ? buildScheduleToolset(options.schedules, registry, {
          ...(options.policy ? { policy: options.policy } : {}),
          requestApproval: (request) => this.requestApproval(request),
          coordinator: this.toolCoordinator,
        })
      : { createTools: {}, extendTools: {}, listTools: {} };
    markToolRole(toolRoles, scheduleToolset.createTools, CAPABILITY_TOOL_ROLES.scheduleCreate);
    markToolRole(toolRoles, scheduleToolset.extendTools, CAPABILITY_TOOL_ROLES.scheduleExtend);
    markToolRole(toolRoles, scheduleToolset.listTools, CAPABILITY_TOOL_ROLES.scheduleList);
    const built = buildAgentToolset(
      options.sources,
      {
        ...(options.policy ? { policy: options.policy } : {}),
        requestApproval: (request) => this.requestApproval(request),
        coordinator: this.toolCoordinator,
      },
      registry,
    );
    markToolRole(toolRoles, built.tools, CAPABILITY_TOOL_ROLES.agent);
    const observationRecallTools =
      built.observationRetentionByToolId.size > 0
        ? buildObservationRecallToolset(
            (input) => this.readObservation(input),
            registry,
            this.toolCoordinator,
            `thread:${this.id}:observation`,
          )
        : {};
    this.observationRecallToolId = Object.keys(observationRecallTools)[0];
    markToolRole(toolRoles, observationRecallTools, CAPABILITY_TOOL_ROLES.observationRead);
    this.tools = {
      ...transcriptTools,
      ...observationRecallTools,
      ...skillTools,
      ...(fileToolset
        ? { ...fileToolset.readTools, ...fileToolset.editTools, ...fileToolset.verifyTools }
        : {}),
      ...bashTools,
      ...sessionExecTools,
      ...agentInstallTools,
      ...scheduleToolset.createTools,
      ...scheduleToolset.extendTools,
      ...scheduleToolset.listTools,
      ...built.tools,
    };
    this.registry = built.registry;
    for (const [id, declaration] of built.observationRetentionByToolId) {
      this.observationRetentionByToolId.set(id, declaration);
    }
    this.toolRoles = toolRoles;
    this.recordToolSchemaIssues(built.schemaIssuesByToolId);
    this.applyToolSchemaPolicy();
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
      tools: this.modelTools(),
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
    this.lastExtraPrompt = extraPrompt;
    this.appliedWorkspaceInstructions = this.workspaceInstructions?.current();
    const compiledPrompt = buildChatSystemPromptFromManifest(this.capabilityManifest, {
      ...(this.derivedFrom !== undefined ? { derivedFrom: this.derivedFrom } : {}),
      ...(this.appliedWorkspaceInstructions !== undefined
        ? { workspaceInstructions: this.appliedWorkspaceInstructions }
        : {}),
    });
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

  private syncWorkspaceInstructions(): void {
    if (this.workspaceInstructions === undefined) {
      return;
    }
    if (this.workspaceInstructions.current() === this.appliedWorkspaceInstructions) {
      return;
    }
    this.systemPrompt = this.compileSystemPrompt(this.lastExtraPrompt);
  }

  private refreshCapabilityManifest(systemPromptOverride?: string): void {
    this.capabilityManifest = this.compileCapabilityManifest();
    this.systemPrompt = this.compileSystemPrompt(systemPromptOverride ?? this.explicitSystemPrompt);
  }

  setUserInputAvailable(available: boolean): void {
    if (this.userInputAvailable === available) {
      return;
    }
    this.userInputAvailable = available;
    if (available) {
      this.tools = { ...this.tools, ...this.userInputTool };
    } else {
      const tools = { ...this.tools };
      delete tools[this.userInputToolId];
      this.tools = tools;
      this.userInputInteractions.cancelAll("当前客户端已撤销用户输入处理能力");
    }
    this.refreshCapabilityManifest();
  }

  resolveUserInput(requestId: SessionUserInputRequestId, result: UserInputResult): boolean {
    return this.userInputInteractions.resolve(requestId, result);
  }

  cancelUserInput(requestId: SessionUserInputRequestId, reason?: string): boolean {
    return this.userInputInteractions.cancel(requestId, reason);
  }

  private async requestUserInput(
    form: UserInputForm,
    abortSignal: AbortSignal | undefined,
  ): Promise<UserInputResult> {
    const activeTurn = this.activeTurn;
    if (!this.userInputAvailable || activeTurn === undefined || this.emit === undefined) {
      return { status: "cancelled", reason: "当前无法向用户请求输入" };
    }
    const now = Date.now();
    const expiresAtMs = this.interactionDeadlineMs(activeTurn, now);
    if (expiresAtMs <= now || abortSignal?.aborted) {
      return { status: "cancelled", reason: "用户输入请求已超时" };
    }
    const interaction = this.userInputInteractions.request(
      form,
      new Date(expiresAtMs).toISOString(),
    );
    const cancelForAbort = (): void => {
      this.userInputInteractions.cancel(interaction.requestId, "本轮已终止");
    };
    abortSignal?.addEventListener("abort", cancelForAbort, { once: true });
    this.emit({
      type: "user-input-required",
      requestId: interaction.requestId,
      form: interaction.form,
      expiresAt: interaction.expiresAt,
    });
    try {
      return await interaction.result;
    } finally {
      abortSignal?.removeEventListener("abort", cancelForAbort);
      const result = await interaction.result;
      this.emit?.({
        type: "user-input-settled",
        requestId: interaction.requestId,
        status: result.status,
      });
    }
  }

  private trackPendingToolCall(
    activeTurn: ActiveTurn,
    toolCallId: string,
    toolName: string,
    input: unknown,
    resources?: readonly ToolResourceAccess[],
  ): PendingToolCall {
    const existing = activeTurn.pendingToolCalls.get(toolCallId);
    if (existing && resources === undefined) {
      return existing;
    }
    const route = this.registry.resolve(toolName);
    const pending: PendingToolCall = {
      toolCallId,
      executionOccurrence:
        existing?.executionOccurrence ?? this.toolCoordinator.captureToolCallOccurrence(toolCallId),
      agentName: route?.agentName ?? toolName,
      toolName: route?.toolName ?? toolName,
      input,
      potentialSideEffect:
        route?.annotations?.readOnlyHint !== true || route.annotations.destructiveHint === true,
      resources: resources ?? existing?.resources ?? [],
    };
    activeTurn.pendingToolCalls.set(toolCallId, pending);
    return pending;
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
      markToolRole(this.toolRoles, built.tools, CAPABILITY_TOOL_ROLES.agent);
      this.tools = { ...this.tools, ...built.tools };
      for (const [id, declaration] of built.observationRetentionByToolId) {
        this.observationRetentionByToolId.set(id, declaration);
      }
      if (
        this.observationRecallToolId === undefined &&
        this.observationRetentionByToolId.size > 0
      ) {
        const recallTools = buildObservationRecallToolset(
          (input) => this.readObservation(input),
          this.registry,
          this.toolCoordinator,
          `thread:${this.id}:observation`,
        );
        this.observationRecallToolId = Object.keys(recallTools)[0];
        markToolRole(this.toolRoles, recallTools, CAPABILITY_TOOL_ROLES.observationRead);
        this.tools = { ...this.tools, ...recallTools };
      }
      this.recordToolSchemaIssues(built.schemaIssuesByToolId);
      this.applyToolSchemaPolicy();
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

  async *send(input: string | SessionSendInput): AsyncIterable<SessionEvent> {
    if (this.closed) {
      throw new Error("session is closed");
    }
    if (this.activeTurn) {
      throw new Error("session already has an active turn");
    }
    const normalizedInput = normalizeSessionSendInput(input);

    const queue = new AsyncEventQueue<SessionEvent>();
    this.emit = (event) => queue.push(event);
    const activeTurn = createActiveTurn();
    this.activeTurn = activeTurn;

    this.runTurn(queue, activeTurn, normalizedInput).catch((error: unknown) => {
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
    input: NormalizedSessionSendInput,
  ): Promise<void> {
    const turnStartedAt = Date.now();
    const recoveryPolicy = this.modelRecovery;
    const recoveryBudget =
      recoveryPolicy === undefined ? undefined : new ModelRecoveryBudget(recoveryPolicy);
    let terminalModelError: unknown;
    let turnStart: number | undefined;
    let turnTimeout: ReturnType<typeof setTimeout> | undefined;
    const expireTurn = (): void => {
      if (activeTurn.abortController.signal.aborted) return;
      this.captureCancellationActivity(activeTurn);
      activeTurn.aborted = true;
      activeTurn.cancellationReason = SESSION_CANCELLATION_REASONS.timeout;
      this.gate.abortAll("本轮运行超时");
      this.userInputInteractions.cancelAll("本轮运行超时");
      activeTurn.abortController.abort(TURN_TIMEOUT_ABORT_REASON);
    };
    const userMessageContent = buildUserMessageContent(input.text, input.attachments);
    try {
      recoveryPolicy?.onTurnStart?.();
      const rawUserMessage: UserModelMessage = { role: "user", content: userMessageContent };
      let inputSequence: number;
      try {
        if (this.onAcceptInput !== undefined) {
          inputSequence = this.onAcceptInput(activeTurn.inputId, rawUserMessage).transcriptSequence;
        } else {
          // Legacy persistence cannot share coverage: a new user prompt is not Tool evidence.
          inputSequence = (this.listCompactionTranscriptEvidence().at(-1)?.sequence ?? -1) + 1;
          this.onPersist?.([rawUserMessage]);
        }
        this.recordPersistedMessagesInMemory([rawUserMessage]);
        this.messages.push(rawUserMessage);
        activeTurn.userMessagePersisted = true;
        turnStart = this.messages.length;
      } catch (error) {
        queue.push({
          type: "error",
          stage: "plan",
          message: `输入持久化失败，未开始模型请求: ${errorMessage(error)}`,
        });
        return;
      }
      if (this.turnTimeoutMs !== undefined) {
        const remainingMs = Math.max(0, this.turnTimeoutMs - (Date.now() - turnStartedAt));
        activeTurn.expiresAt = new Date(turnStartedAt + this.turnTimeoutMs).toISOString();
        turnTimeout = setTimeout(expireTurn, remainingMs);
        if (remainingMs === 0) expireTurn();
      }
      this.debug(queue, "turn", "start", turnStartedAt, {
        messages: this.messages.length,
        tools: Object.keys(this.modelTools()).length,
        maxSteps: this.maxSteps,
        ...(input.attachments.length > 0 ? { attachments: input.attachments.length } : {}),
        ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
        ...(this.lastInputTokens !== undefined ? { lastInputTokens: this.lastInputTokens } : {}),
      });
      try {
        this.reconcileUncoveredToolExecutionContext();
      } catch (error) {
        queue.push({
          type: "error",
          stage: "plan",
          message: `工具执行恢复状态持久化失败: ${errorMessage(error)}`,
        });
        return;
      }
      // Reconciliation may append durable recovery evidence after the accepted input.
      turnStart = this.messages.length;
      if (this.isTurnAborted(activeTurn)) {
        this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
        return;
      }
      this.syncWorkspaceInstructions();
      let contextRecoveryAttempts = 0;
      let compactionAttempted = false;
      let advisoryMiss: RequestBudgetSnapshot | undefined;
      const advisoryGrowth = (): number => Math.max(1024, (this.contextWindow ?? 0) * 0.05);
      const canRetryAdvisory = (tokens: number): boolean =>
        advisoryMiss === undefined ||
        tokens >= advisoryMiss.calibratedInputEstimate + advisoryGrowth();
      const providerRejected = new Set<string>();
      let rejectedBudget: RequestBudgetSnapshot | undefined;
      const invalidScheduleRetryGuard = createInvalidScheduleRetryGuard();
      const explicitSkillContext = prepareExplicitSkillContext({
        rawInput: input.text,
        skillSummaries: this.skillSummaries,
        skillLibrary: this.skillLibrary,
      });
      if (activeTurn.expiresAt !== undefined && Date.now() >= Date.parse(activeTurn.expiresAt)) {
        expireTurn();
      }
      const storedUserMessage = rawUserMessage;
      if (explicitSkillContext.skillNames.length > 0 && !this.isTurnAborted(activeTurn)) {
        const checkpoint = readExplicitSkillCheckpoint(
          attachExplicitSkillCheckpoint(rawUserMessage, explicitSkillContext),
        );
        if (checkpoint === undefined) {
          throw new Error("Explicit Skill checkpoint could not be created");
        }
        this.onRecordInputSkillCheckpoint?.(activeTurn.inputId, checkpoint);
        this.inputSkillCheckpoints.set(
          inputSequence,
          turnInputSkillCheckpointSchema.parse(checkpoint),
        );
      }
      turnStart = this.messages.length;
      if (this.isTurnAborted(activeTurn)) {
        this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
        return;
      }
      queue.push({ type: "message-start", messageId: randomUUID() });
      let externalDynamicContext: CapabilityExternalDynamicContext = {};
      try {
        externalDynamicContext =
          (await awaitAbortable(
            this.resolveDynamicCapabilityContext?.(activeTurn.abortController.signal) ?? {},
            activeTurn.abortController.signal,
          )) ?? {};
      } catch (error) {
        if (this.isTurnAborted(activeTurn)) {
          turnStart = this.messages.length;
          activeTurn.cancellationReason = resolveCancellationReason(
            activeTurn.cancellationReason,
            activeTurn.abortController.signal.reason ?? error,
          );
          this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
          return;
        }
        this.debug(queue, "turn", "dynamic capability context unavailable", turnStartedAt, {
          message: errorMessage(error),
        });
      }
      const capabilityTurnContext = buildEffectiveCapabilityTurnContext(this.capabilityManifest, {
        explicitSkillNames: explicitSkillContext.skillNames,
        ...(externalDynamicContext.ruleIds ? { ruleIds: externalDynamicContext.ruleIds } : {}),
        ...(externalDynamicContext.vcs ? { vcs: externalDynamicContext.vcs } : {}),
        ...(externalDynamicContext.origin ? { origin: externalDynamicContext.origin } : {}),
        sessions: (this.sessionManager?.list() ?? []).map((session) => ({
          sessionId: session.sessionId,
          state: session.state,
        })),
      });
      this.lastCapabilityTurnContext = capabilityTurnContext;
      const capabilityTurnReminder = buildCapabilityTurnReminder(capabilityTurnContext);
      // Continuations belong to one send; keep turn usage separate from each SDK stream total.
      let turnUsage: SessionTokenUsage | undefined;
      while (true) {
        turnStart = this.messages.length;
        activeTurn.pausedForContextPressure = false;
        const transcriptToolId = findCapabilityToolId(
          this.capabilityManifest,
          CAPABILITY_TOOL_ROLES.transcriptRead,
        );
        const checkpointReminder = this.currentCheckpointReminder(transcriptToolId);
        const reminderTokens =
          checkpointReminder === undefined ? 0 : estimateTextTokens(checkpointReminder);
        const streamTools = this.modelTools();
        const buildRequest = (completedMessages: readonly ModelMessage[] = []) =>
          buildSessionModelRequest({
            history: this.messages,
            completedMessages,
            explicitSkill: explicitSkillContext,
            capabilityReminder: capabilityTurnReminder,
            ...(checkpointReminder === undefined ? {} : { checkpointReminder }),
            system: this.systemPrompt,
            tools: streamTools,
            ...(this.providerOptions === undefined
              ? {}
              : { providerOptions: this.providerOptions }),
            project: (messages) => this.projectModelMessages(messages),
          });
        const initialRequest = buildRequest();
        let preparedShapeContext = initialRequest.shapeContext;
        this.debug(queue, "model", "calling streamText", turnStartedAt, {
          messages: this.messages.length,
          tools: Object.keys(this.modelTools()).length,
          contextRecoveryAttempts,
          ...(this.turnTimeoutMs !== undefined ? { timeoutMs: this.turnTimeoutMs } : {}),
        });
        let lastPreparedComparableTokens = 0;
        let projectedBaselineTokens = 0;
        let contextInputBaselineTokens: number | undefined;
        const currentStreamCanonicalMessages: ModelMessage[] = [];
        let ownedPause: ContextMaintenanceRequired | undefined;
        let dispatchedBudget: RequestBudgetSnapshot | undefined;
        let streamMeasuredUsage: SessionTokenUsage | undefined;
        let providerStepFinished = false;
        const guardedModel = wrapLanguageModel({
          model: this.model,
          middleware: {
            specificationVersion: "v4",
            wrapStream: async ({ params, doStream }) => {
              if (activeTurn.abortController.signal.aborted) {
                throw activeTurn.abortController.signal.reason;
              }
              const budget = this.requestBudgets.prepare(
                params,
                {
                  provider: this.model.provider,
                  model: this.model.modelId,
                  ...(this.contextWindow === undefined ? {} : { window: this.contextWindow }),
                  ...(this.contextWindowSource === undefined
                    ? {}
                    : { windowSource: this.contextWindowSource }),
                  threshold: this.compaction?.threshold ?? 0.75,
                },
                preparedShapeContext,
                activeTurn.inputId,
              );
              const maintenanceTarget = budget.maintenanceTarget;
              const currentTools = this.modelTools();
              const shapeChanged =
                Object.keys(currentTools).length !== Object.keys(streamTools).length ||
                Object.entries(streamTools).some(
                  ([id, definition]) => currentTools[id] !== definition,
                );
              const unsafe =
                budget.availableInputCeiling !== undefined &&
                budget.calibratedInputEstimate > budget.availableInputCeiling;
              const soft =
                !compactionAttempted &&
                this.compaction?.enabled === true &&
                maintenanceTarget !== undefined &&
                budget.calibratedInputEstimate >= maintenanceTarget &&
                (canRetryAdvisory(budget.calibratedInputEstimate) ||
                  (advisoryMiss !== undefined &&
                    (budget.shapeFingerprint !== advisoryMiss.shapeFingerprint ||
                      budget.rawInputEstimate >=
                        advisoryMiss.rawInputEstimate + advisoryGrowth())));
              const rejected =
                providerRejected.has(budget.fingerprint) ||
                (rejectedBudget !== undefined &&
                  budget.rawInputEstimate >= rejectedBudget.rawInputEstimate);
              if (shapeChanged || unsafe || soft || rejected) {
                ownedPause = new ContextMaintenanceRequired(
                  budget,
                  shapeChanged
                    ? "shape_changed"
                    : rejected
                      ? "provider_rejected"
                      : unsafe
                        ? "budget"
                        : "soft_target",
                );
                throw ownedPause;
              }
              compactionAttempted = false;
              dispatchedBudget = budget;
              this.requestBudgets.dispatchedRequest();
              providerStepFinished = false;
              const response = await doStream();
              if (recoveryPolicy === undefined) return response;
              const reader = response.stream.getReader();
              let providerStepFailed = false;
              return {
                ...response,
                stream: new ReadableStream<LanguageModelV4StreamPart>({
                  async pull(controller) {
                    let next: Awaited<ReturnType<typeof reader.read>>;
                    try {
                      next = await reader.read();
                    } catch (error) {
                      // Normalize only provider reader failures. Errors from persistence and other
                      // consumers remain outside this boundary and must never authorize a retry.
                      providerStepFinished = false;
                      controller.enqueue({ type: "error", error });
                      controller.close();
                      reader.releaseLock();
                      return;
                    }
                    if (next.done) {
                      controller.close();
                      reader.releaseLock();
                      return;
                    }
                    const part = next.value;
                    if (part.type === "finish" && providerStepFailed) return;
                    if (part.type === "finish" && part.finishReason.unified === "error") {
                      providerStepFailed = true;
                      providerStepFinished = false;
                      // An error finish must not become SDK model-call-end, which starts tools.
                      controller.enqueue({
                        type: "error",
                        error: new Error("模型未成功完成本步骤，未执行待处理工具。"),
                      });
                      return;
                    }
                    if (part.type === "finish") providerStepFinished = true;
                    if (part.type === "error") {
                      providerStepFinished = false;
                      providerStepFailed = true;
                    }
                    controller.enqueue(part);
                  },
                  async cancel(reason) {
                    try {
                      await reader.cancel(reason);
                    } finally {
                      reader.releaseLock();
                    }
                  },
                }),
              };
            },
          },
        });
        const createStreamResult = () =>
          streamText({
            model: guardedModel,
            ...(recoveryPolicy === undefined ? {} : { maxRetries: 0 }),
            system: initialRequest.system,
            messages: initialRequest.messages,
            tools: streamTools,
            prepareStep: () => {
              lastPreparedComparableTokens = estimateMessagesTokens(
                this.projectModelMessages([...this.messages, ...currentStreamCanonicalMessages]),
              );
              const request = buildRequest(currentStreamCanonicalMessages);
              preparedShapeContext = request.shapeContext;
              projectedBaselineTokens = this.requestBudgets.projectedMessageTokens(
                request.messages,
              );
              return { messages: request.messages, system: request.system };
            },
            stopWhen: [
              () => recoveryPolicy !== undefined && !providerStepFinished,
              stepCountIs(Math.max(1, this.maxSteps - activeTurn.completedStepCount)),
              stopOnUserRejected(),
              invalidScheduleRetryGuard.stop,
              this.stopOnContextPressure(
                activeTurn,
                () => lastPreparedComparableTokens,
                () =>
                  this.requestBudgets.predict(
                    buildRequest(currentStreamCanonicalMessages).messages,
                    projectedBaselineTokens,
                  ),
                canRetryAdvisory,
              ),
            ],
            toolApproval: async ({ toolCall }) => {
              this.trackPendingToolCall(
                activeTurn,
                toolCall.toolCallId,
                toolCall.toolName,
                toolCall.input,
              );
              await this.toolCoordinator.prepare(
                toolCall.toolCallId,
                toolCall.toolName,
                toolCall.input,
              );
              return undefined;
            },
            onLanguageModelCallStart: ({ callId }) => this.toolCoordinator.startBatch(callId),
            onLanguageModelCallEnd: ({ callId, content, usage, finishReason }) => {
              // Seal the actual finish chunk, not the reader's look-ahead state. A later
              // stream failure must not leave already admitted SDK executions waiting forever.
              if (recoveryPolicy !== undefined && finishReason === "error") return;
              streamMeasuredUsage = addUsage(streamMeasuredUsage ?? {}, toSessionUsage(usage));
              if (dispatchedBudget !== undefined) {
                this.requestBudgets.measured(dispatchedBudget, usage.inputTokens);
              }
              this.toolCoordinator.sealBatch(
                callId,
                content.flatMap((part) =>
                  part.type === "tool-call" &&
                  part.providerExecuted !== true &&
                  (!("invalid" in part) || part.invalid !== true)
                    ? [{ toolCallId: part.toolCallId, toolId: part.toolName }]
                    : [],
                ),
              );
            },
            abortSignal: activeTurn.abortController.signal,
            ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
            onError: () => undefined,
            onStepEnd: (step) => {
              if (recoveryPolicy !== undefined && !providerStepFinished) return;
              currentStreamCanonicalMessages.push(...rememberCompletedStep(activeTurn, step));
            },
            onAbort: ({ steps }) => {
              // Recovery mode already recorded verified steps through onStepEnd. SDK's abort
              // snapshot may also contain a partial step synthesized after a stream error.
              if (recoveryPolicy === undefined) {
                for (const step of steps) rememberCompletedStep(activeTurn, step);
              }
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
            this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
            return;
          }
          if (!isContextWindowError(error)) {
            throw error;
          }
          this.messages.splice(turnStart);
          const canRetry = contextRecoveryAttempts < MAX_CONTEXT_RECOVERY_ATTEMPTS;
          const compacted = canRetry
            ? await this.recoverFromContextError(queue, activeTurn)
            : false;
          if (this.isTurnAborted(activeTurn)) {
            this.persistCancelledRecoveryTurn(queue, activeTurn, storedUserMessage, turnStartedAt);
            return;
          }
          if (compacted && canRetry) {
            contextRecoveryAttempts += 1;
            continue;
          }
          this.persistContextFailure(queue, activeTurn, storedUserMessage, false, turnStartedAt);
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
        let rawStreamError: unknown;
        let modelStreamFailure = false;
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
        const toolInputActivity = new ToolInputActivityTracker(
          (name) => {
            const route = this.registry.resolve(name);
            return route === undefined ? undefined : `${route.agentName}.${route.toolName}`;
          },
          (event) => queue.push(event),
        );
        const clearToolInputActivity = (): void => toolInputActivity.clear();
        activeTurn.abortController.signal.addEventListener("abort", clearToolInputActivity, {
          once: true,
        });
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
              case "start-step":
                if (recoveryPolicy !== undefined) queue.push({ type: "model-step-start" });
                break;
              case "tool-input-start":
                toolInputActivity.start(part.id, part.toolName);
                break;
              case "tool-input-delta":
                toolInputActivity.delta(part.id);
                break;
              case "tool-input-end":
                toolInputActivity.end(part.id);
                break;
              case "reasoning-start":
                queue.push({ type: "reasoning-start", reasoningId: part.id });
                break;
              case "reasoning-delta":
                queue.push({
                  type: "reasoning-delta",
                  reasoningId: part.id,
                  delta: part.text,
                });
                break;
              case "reasoning-end":
                queue.push({ type: "reasoning-end", reasoningId: part.id });
                break;
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
                toolInputActivity.end(part.toolCallId);
                sawToolCall = true;
                pendingEchoText = "";
                const pending = this.trackPendingToolCall(
                  activeTurn,
                  part.toolCallId,
                  part.toolName,
                  part.input,
                  this.toolCoordinator.describeResources(part.toolName, part.input),
                );
                queue.push({
                  type: "tool-call",
                  toolCallId: part.toolCallId,
                  agentName: pending.agentName,
                  toolName: pending.toolName,
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
                this.persistToolExecution(record, activeTurn);
                const canonicalObservation =
                  outcome.kind === TOOL_OUTCOME_KINDS.success
                    ? canonicalObservationOutput(
                        result.raw,
                        this.observationRetentionByToolId.get(part.toolName),
                      )
                    : undefined;
                if (canonicalObservation) {
                  activeTurn.canonicalObservationOutputs.set(part.toolCallId, canonicalObservation);
                  const previousId = this.observationResultIds.get(part.toolCallId);
                  if (previousId !== undefined && previousId !== record.id) {
                    this.ambiguousObservationCallIds.add(part.toolCallId);
                  }
                  this.observationResultIds.set(
                    part.toolCallId,
                    this.ambiguousObservationCallIds.has(part.toolCallId) ? undefined : record.id,
                  );
                }
                if (
                  pending?.potentialSideEffect === true &&
                  outcome.kind !== TOOL_OUTCOME_KINDS.userRejected &&
                  outcome.kind !== TOOL_OUTCOME_KINDS.policyDenied &&
                  outcome.kind !== TOOL_OUTCOME_KINDS.invalidInput
                ) {
                  activeTurn.hadPotentialSideEffects = true;
                }
                activeTurn.pendingToolCalls.delete(part.toolCallId);
                queue.push({
                  type: "tool-result",
                  toolCallId: part.toolCallId,
                  agentName: route?.agentName ?? part.toolName,
                  toolName: route?.toolName ?? part.toolName,
                  executionId: record.id,
                  ...(record.appOutput === undefined
                    ? {}
                    : { appOutput: describeAppOutput(record.appOutput) }),
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
                toolInputActivity.end(part.toolCallId);
                const route = this.registry.resolve(part.toolName);
                const outcomeKind = toolErrorOutcomeKind(part.error);
                const friendly =
                  outcomeKind === TOOL_OUTCOME_KINDS.invalidInput
                    ? friendlyInvalidToolInputMessage(part.error)
                    : undefined;
                const output = friendly ?? toolOutputMessage(part.error);
                const result = failedToolResult(outcomeKind, output, {
                  raw: part.error,
                });
                const record = createToolExecutionRecord({
                  toolCallId: part.toolCallId,
                  agentName: route?.agentName ?? part.toolName,
                  toolName: route?.toolName ?? part.toolName,
                  input: activeTurn.pendingToolCalls.get(part.toolCallId)?.input,
                  result,
                });
                this.persistToolExecution(record, activeTurn);
                if (
                  activeTurn.pendingToolCalls.get(part.toolCallId)?.potentialSideEffect === true &&
                  result.outcome.kind !== TOOL_OUTCOME_KINDS.invalidInput
                ) {
                  activeTurn.hadPotentialSideEffects = true;
                }
                activeTurn.pendingToolCalls.delete(part.toolCallId);
                queue.push({
                  type: "tool-result",
                  toolCallId: part.toolCallId,
                  agentName: route?.agentName ?? part.toolName,
                  toolName: route?.toolName ?? part.toolName,
                  executionId: record.id,
                  ...(record.appOutput === undefined
                    ? {}
                    : { appOutput: describeAppOutput(record.appOutput) }),
                  outcome: result.outcome,
                  display: result.display,
                  output,
                  isError: true,
                });
                break;
              }
              case "finish-step": {
                toolInputActivity.clear();
                if (recoveryPolicy !== undefined && streamError !== undefined) break;
                const stepUsage = toSessionUsage(part.usage);
                if (stepUsage.inputTokens !== undefined) {
                  contextInputTokens = stepUsage.inputTokens;
                  contextInputBaselineTokens = lastPreparedComparableTokens;
                }
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
                toolInputActivity.clear();
                if (this.isTurnAborted(activeTurn) || isTurnTimeoutAbortReason(part.error)) {
                  activeTurn.aborted = true;
                  activeTurn.cancellationReason = resolveCancellationReason(
                    activeTurn.cancellationReason,
                    part.error,
                  );
                  break;
                }
                streamContextOverflow = isContextWindowError(part.error);
                rawStreamError = part.error;
                modelStreamFailure = true;
                streamError = errorMessage(part.error);
                break;
              case "abort":
                toolInputActivity.clear();
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
            rawStreamError = error;
            // Only provider-stream failures are recoverable, never persistence/consumer failures.
            modelStreamFailure = false;
            streamError = errorMessage(error);
          }
        } finally {
          activeTurn.abortController.signal.removeEventListener("abort", clearToolInputActivity);
          toolInputActivity.dispose();
          this.clearDebugTimer(firstPartTimer);
        }
        this.debug(queue, "model", "fullStream finished", turnStartedAt, {
          textChars: text.length,
        });

        if (ownedPause !== undefined) {
          // SDK may reject result.steps generically on an initial refusal; the stream-owned marker
          // remains authoritative. Completed steps were remembered before the next preparation.
          try {
            await awaitAbortable(result.steps, activeTurn.abortController.signal);
          } catch {
            /* no completed initial step; marker is already owned */
          }
          if (this.isTurnAborted(activeTurn)) {
            this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
            return;
          }
          if (activeTurn.pendingToolCalls.size > 0) {
            this.persistFailedTurn(queue, activeTurn, storedUserMessage, turnStartedAt);
            queue.push({
              type: "error",
              stage: "execute",
              message: "context_maintenance_unsettled_tools：输入已保存，请先核对未结算操作。",
            });
            return;
          }
          const settled = stripReasoningMessages(unpersistedStepMessages(activeTurn));
          this.messages.push(...settled);
          if (settled.length > 0) this.persistMessages(settled, "raw_transcript");
          markTurnSegmentPersisted(activeTurn);
          turnStart = this.messages.length;
          activeTurn.completedStepCount += stepCount;
          if (streamMeasuredUsage !== undefined) {
            turnUsage =
              turnUsage === undefined
                ? streamMeasuredUsage
                : addUsage(turnUsage, streamMeasuredUsage);
            this.sessionUsage = addUsage(this.sessionUsage, streamMeasuredUsage);
          }
          // No successful call-end is invented for a denied dispatch. Retire its empty batch.
          this.toolCoordinator.finishTurn();
          const pause = ownedPause;
          // Settling changes the actual request (including stripping transient reasoning).
          // Re-prepare it before declaring recovery impossible. This route requires fresh
          // completed steps and remains bounded by the original turn's step limit.
          if (settled.length > 0) {
            if (activeTurn.completedStepCount >= this.maxSteps) {
              queue.push({
                type: "message-finish",
                text,
                stoppedAtStepLimit: true,
                sessionUsage: { ...this.sessionUsage },
                ...(turnUsage === undefined ? {} : { totalUsage: turnUsage }),
                ...(contextInputTokens === undefined ? {} : { contextInputTokens }),
              });
              return;
            }
            queue.push({ type: "message-start", messageId: randomUUID() });
            continue;
          }
          if (pause.reason === "shape_changed") continue;
          if (compactionAttempted || this.compaction?.enabled !== true) {
            queue.push({
              type: "error",
              stage: "plan",
              message: `context_request_budget_unrecoverable：输入和已完成操作已保留；当前请求未通过预算检查（${pause.reason}，估算输入 ${Math.ceil(pause.budget.calibratedInputEstimate)}，输入上限 ${pause.budget.availableInputCeiling ?? "未知"}，最近实测 ${pause.budget.latestMeasuredInput ?? "未知"}）。可继续发送较小的新要求或手动压缩。`,
            });
            return;
          }
          compactionAttempted = true;
          this.requestBudgets.beginMaintenance(pause.budget, activeTurn.inputId);
          const target =
            pause.budget.maintenanceTarget === undefined
              ? undefined
              : Math.max(
                  1,
                  pause.budget.maintenanceTarget * 0.5 -
                    (pause.budget.calibratedInputEstimate - pause.budget.messageTokens),
                );
          let compacted = false;
          try {
            compacted = await this.runCompaction(
              queue,
              "auto",
              activeTurn,
              false,
              target,
              (history, reminder) =>
                buildSessionModelRequest({
                  history,
                  explicitSkill: explicitSkillContext,
                  capabilityReminder: capabilityTurnReminder,
                  ...(reminder === undefined ? {} : { checkpointReminder: reminder }),
                  system: this.systemPrompt,
                  tools: streamTools,
                  project: (messages) => this.projectModelMessages(messages),
                  ...(this.providerOptions === undefined
                    ? {}
                    : { providerOptions: this.providerOptions }),
                }).messages,
            );
          } catch (error) {
            if (this.isTurnAborted(activeTurn)) throw error;
            // A failed summary does not deny an otherwise admissible request.
            this.debug(
              queue,
              "compaction",
              "summary failed; original context retained",
              turnStartedAt,
              {
                message: errorMessage(error),
              },
            );
          }
          // Suppress immediate soft-target retries; the finalized request still enforces
          // the hard ceiling and provider rejection after this one bounded attempt.
          advisoryMiss = compacted ? undefined : pause.budget;
          turnStart = this.messages.length;
          if (this.isTurnAborted(activeTurn)) {
            this.persistPausedTurnCancellation(queue, activeTurn, turnStartedAt);
            return;
          }
          // The next real SDK preparation (not a shadow conversion) verifies finalized budgetAfter.
          queue.push({ type: "message-start", messageId: randomUUID() });
          continue;
        }
        if (streamError !== undefined && this.isTurnAborted(activeTurn)) {
          this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
          return;
        }
        if (
          streamError !== undefined &&
          !streamContextOverflow &&
          modelStreamFailure &&
          recoveryPolicy?.isRecoverable(rawStreamError) &&
          recoveryBudget !== undefined &&
          !activeTurn.userRejected &&
          userRejectionMessage === undefined &&
          invalidScheduleRetryGuard.message === undefined
        ) {
          // Keep the provider failure even if tool settlement later prevents recovery.
          // Retry eligibility and the final connection state are separate facts.
          terminalModelError = rawStreamError;
          try {
            await awaitAbortable(result.steps, activeTurn.abortController.signal);
          } catch (error) {
            activeTurn.abortController.signal.throwIfAborted();
            // Only the SDK's documented no-output rejection is expected here. Callback or
            // settlement failures must stop before batch retirement or another model request.
            if (!NoOutputGeneratedError.isInstance(error) && error !== rawStreamError) throw error;
          }
          const settled = stripReasoningMessages(unpersistedStepMessages(activeTurn));
          const coveredResults = new Map<string, number>();
          for (const message of settled) {
            if (message.role !== "tool") continue;
            for (const part of message.content) {
              if (part.type === "tool-result") {
                coveredResults.set(part.toolCallId, (coveredResults.get(part.toolCallId) ?? 0) + 1);
              }
            }
          }
          const missingResult = [...this.uncoveredToolExecutions.values()].some((record) => {
            const count = coveredResults.get(record.toolCallId) ?? 0;
            coveredResults.set(record.toolCallId, count - 1);
            return count === 0;
          });
          if (
            missingResult ||
            [...activeTurn.pendingToolCalls.values()].some((pending) =>
              this.toolCoordinator.hasExecutionStarted(pending.executionOccurrence),
            )
          ) {
            // Fail closed: ledger evidence must not be marked covered by an unrelated transcript.
            modelStreamFailure = false;
            streamError = "网络中断且操作结果尚未完整结算；已停止自动恢复，请先核对结果。";
          } else {
            // fullStream and result.steps have drained SDK toolApproval/execute callbacks.
            this.toolCoordinator.finishTurn();
            // Commit completed steps before cancelling unexecuted calls so coverage stays truthful.
            if (settled.length > 0) {
              this.persistMessages(settled, "raw_transcript");
              this.messages.push(...settled);
            }
            markTurnSegmentPersisted(activeTurn);
            turnStart = this.messages.length;
            this.persistRecoveryCancellations(queue, activeTurn);
            turnStart = this.messages.length;
            activeTurn.completedStepCount += stepCount;
            if (streamMeasuredUsage !== undefined) {
              turnUsage =
                turnUsage === undefined
                  ? streamMeasuredUsage
                  : addUsage(turnUsage, streamMeasuredUsage);
              this.sessionUsage = addUsage(this.sessionUsage, streamMeasuredUsage);
            }
            if (activeTurn.completedStepCount >= this.maxSteps) {
              queue.push({
                type: "error",
                stage: "execute",
                message: "已达单轮最大工具步数；未完成的回复已丢弃，输入和已完成的操作已保留。",
              });
              return;
            }
            const recovered = await recoveryBudget.attempt(
              rawStreamError,
              activeTurn.abortController.signal,
              (attempt) => queue.push({ type: "model-recovery", attempt }),
            );
            if (recovered.recovered) {
              terminalModelError = undefined;
              continue;
            }
            rawStreamError = recovered.error;
            streamError = errorMessage(recovered.error);
          }
        }
        if (streamError !== undefined) {
          if (modelStreamFailure && !streamContextOverflow) terminalModelError = rawStreamError;
          if (modelStreamFailure && !streamContextOverflow && recoveryPolicy?.formatError) {
            streamError = recoveryPolicy.formatError(rawStreamError);
          }
          if (streamContextOverflow && dispatchedBudget !== undefined) {
            providerRejected.add(dispatchedBudget.fingerprint);
            rejectedBudget = dispatchedBudget;
          }
          this.messages.splice(turnStart);
          if (streamContextOverflow) {
            const retrySafe = text.length === 0 && !sawToolCall;
            const canRetry = retrySafe && contextRecoveryAttempts < MAX_CONTEXT_RECOVERY_ATTEMPTS;
            const compacted =
              canRetry || !retrySafe
                ? await this.recoverFromContextError(queue, activeTurn)
                : false;
            if (this.isTurnAborted(activeTurn)) {
              this.persistCancelledRecoveryTurn(
                queue,
                activeTurn,
                storedUserMessage,
                turnStartedAt,
              );
              return;
            }
            if (retrySafe && compacted && canRetry) {
              contextRecoveryAttempts += 1;
              continue;
            }
            const suffix = retrySafe
              ? ""
              : "；本次尝试已有内容或操作开始执行，为避免重复执行，未自动重试";
            this.persistContextFailure(
              queue,
              activeTurn,
              storedUserMessage,
              text.length > 0,
              turnStartedAt,
            );
            queue.push({ type: "error", stage: "execute", message: `${streamError}${suffix}` });
            return;
          }
          this.persistFailedTurn(queue, activeTurn, storedUserMessage, turnStartedAt);
          queue.push({ type: "error", stage: "execute", message: streamError });
          return;
        }

        if (activeTurn.aborted || activeTurn.abortController.signal.aborted) {
          activeTurn.cancellationReason = resolveCancellationReason(
            activeTurn.cancellationReason,
            activeTurn.abortController.signal.reason,
          );
          this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
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
          responseMessages = canonicalMessagesForSteps(activeTurn, steps);
        } catch (error) {
          this.clearDebugTimer(responseTimer);
          if (this.isTurnAborted(activeTurn) || isTurnTimeoutAbortReason(error)) {
            activeTurn.aborted = true;
            activeTurn.cancellationReason = resolveCancellationReason(
              activeTurn.cancellationReason,
              error,
            );
            this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
            return;
          }
          const contextOverflow = isContextWindowError(error);
          if (contextOverflow) {
            if (dispatchedBudget !== undefined) {
              rejectedBudget = dispatchedBudget;
              providerRejected.add(dispatchedBudget.fingerprint);
            }
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
              this.persistCancelledRecoveryTurn(
                queue,
                activeTurn,
                storedUserMessage,
                turnStartedAt,
              );
              return;
            }
            if (retrySafe && compacted && canRetry) {
              contextRecoveryAttempts += 1;
              continue;
            }
            const suffix = retrySafe
              ? ""
              : "；本次尝试已有内容或操作开始执行，为避免重复执行，未自动重试";
            this.persistContextFailure(
              queue,
              activeTurn,
              storedUserMessage,
              text.length > 0,
              turnStartedAt,
            );
            queue.push({
              type: "error",
              stage: "execute",
              message: `${errorMessage(error)}${suffix}`,
            });
            return;
          }
          this.persistFailedTurn(queue, activeTurn, storedUserMessage, turnStartedAt);
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
          this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
          return;
        }

        const visibleResponseMessages = stripReasoningMessages(responseMessages);
        this.messages.push(...visibleResponseMessages);
        const stopMessage = userRejectionMessage ?? invalidScheduleRetryGuard.message;
        if (stopMessage !== undefined) {
          const delta = text.length === 0 ? stopMessage : `\n${stopMessage}`;
          text += delta;
          queue.push({ type: "text-delta", delta });
          this.messages.push({ role: "assistant", content: stopMessage });
        }
        this.debug(queue, "persist", "persisting messages", turnStartedAt, {
          appendedMessages: this.messages.length - turnStart,
        });
        this.persistMessages(this.messages.slice(turnStart), "raw_transcript");
        markTurnSegmentPersisted(activeTurn);
        turnStart = this.messages.length;
        this.debug(queue, "persist", "messages persisted", turnStartedAt, {
          totalMessages: this.messages.length,
        });
        if (totalUsage) {
          turnUsage = turnUsage === undefined ? totalUsage : addUsage(turnUsage, totalUsage);
          this.sessionUsage = addUsage(this.sessionUsage, totalUsage);
        }
        const pressureInputTokens = contextInputTokens;
        if (pressureInputTokens !== undefined) {
          this.lastInputTokens = pressureInputTokens;
          this.measuredProjectedTokens = contextInputBaselineTokens ?? lastPreparedComparableTokens;
          this.promptOverhead = Math.max(
            0,
            pressureInputTokens - this.measuredProjectedTokens - reminderTokens,
          );
        }
        activeTurn.completedStepCount += stepCount;
        const stoppedAtStepLimit =
          activeTurn.completedStepCount >= this.maxSteps && lastStepFinishReason === "tool-calls";
        queue.push({
          type: "message-finish",
          text,
          ...(turnUsage === undefined ? {} : { totalUsage: turnUsage }),
          sessionUsage: { ...this.sessionUsage },
          ...(contextInputTokens !== undefined ? { contextInputTokens } : {}),
          ...(outputTokensPerSecond !== undefined ? { outputTokensPerSecond } : {}),
          ...(stoppedAtStepLimit ? { stoppedAtStepLimit: true } : {}),
        });
        if (
          !activeTurn.pausedForContextPressure ||
          lastStepFinishReason !== "tool-calls" ||
          stoppedAtStepLimit ||
          stopMessage !== undefined
        ) {
          return;
        }
        activeTurn.pausedForContextPressure = false;
        this.debug(queue, "compaction", "turn paused for context pressure", turnStartedAt, {
          continuations: activeTurn.contextPressureContinuations,
          pressureTokens: this.contextPressureTokens(),
        });
        if (this.isTurnAborted(activeTurn)) {
          this.persistPausedTurnCancellation(queue, activeTurn, turnStartedAt);
          return;
        }
        queue.push({ type: "message-start", messageId: randomUUID() });
      }
    } catch (error) {
      if (this.isTurnAborted(activeTurn) || isTurnTimeoutAbortReason(error)) {
        activeTurn.aborted = true;
        activeTurn.cancellationReason = resolveCancellationReason(
          activeTurn.cancellationReason,
          activeTurn.abortController.signal.reason ?? error,
        );
        if (turnStart !== undefined) {
          this.persistCancelledTurn(queue, activeTurn, turnStart, turnStartedAt);
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
      this.requestBudgets.abandonMaintenance(activeTurn.inputId);
      if (turnTimeout !== undefined) {
        clearTimeout(turnTimeout);
      }
      this.toolCoordinator.finishTurn();
      try {
        recoveryPolicy?.onTurnEnd?.(
          this.isTurnAborted(activeTurn) ? undefined : terminalModelError,
        );
      } finally {
        if (this.activeTurn === activeTurn) {
          this.activeTurn = undefined;
        }
        queue.close();
      }
    }
  }

  private persistMessages(
    messages: readonly ModelMessage[],
    representation: ToolExecutionContextRepresentation,
  ): void {
    const executionIds = [...this.uncoveredToolExecutions.keys()];
    const options: AppendMessagesOptions | undefined =
      executionIds.length === 0
        ? undefined
        : {
            toolExecutionCoverage: {
              executionIds,
              representation,
            },
          };
    this.onPersist?.(messages, options);
    this.recordPersistedMessagesInMemory(messages);
    for (const executionId of executionIds) {
      this.uncoveredToolExecutions.delete(executionId);
    }
  }

  private recordPersistedMessagesInMemory(messages: readonly ModelMessage[]): void {
    if (this.listPersistedTranscriptMessages !== undefined) {
      return;
    }
    let sequence = (this.inMemoryTranscript.at(-1)?.sequence ?? -1) + 1;
    const createdAt = new Date().toISOString();
    for (const message of messages) {
      if (isDerivedCompactionReminderMessage(message)) {
        continue;
      }
      this.inMemoryTranscript.push({
        sequence,
        provenance: TRANSCRIPT_MESSAGE_PROVENANCES[0],
        createdAt,
        message,
      });
      sequence += 1;
    }
  }

  private reconcileUncoveredToolExecutionContext(): void {
    if (this.recoverPersistedToolExecutionContext !== undefined) {
      const recoveredMessages = this.recoverPersistedToolExecutionContext();
      this.messages.push(...recoveredMessages);
      this.recordPersistedMessagesInMemory(recoveredMessages);
      this.uncoveredToolExecutions.clear();
      return;
    }
    const records = [...this.uncoveredToolExecutions.values()];
    if (records.length === 0) {
      return;
    }
    const rollbackTo = this.messages.length;
    const recovery = createToolLedgerGapRecoveryMessage(records);
    this.messages.push(recovery);
    try {
      this.persistMessages([recovery], "recovery_evidence");
    } catch (error) {
      this.messages.splice(rollbackTo);
      throw error;
    }
  }

  private persistContextFailure(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    userMessage: UserModelMessage,
    producedText: boolean,
    turnStartedAt: number,
  ): void {
    if (
      !this.persistPendingToolCancellationsOrReport(
        queue,
        activeTurn,
        "上下文溢出工具状态持久化失败",
      )
    ) {
      return;
    }
    const hadToolActivity = activeTurn.toolExecutions.some((record) => {
      if (
        record.outcome.kind === TOOL_OUTCOME_KINDS.policyDenied ||
        record.outcome.kind === TOOL_OUTCOME_KINDS.userRejected ||
        record.outcome.kind === TOOL_OUTCOME_KINDS.invalidInput
      ) {
        return false;
      }
      if (record.outcome.kind === TOOL_OUTCOME_KINDS.cancelled) {
        return record.outcome.executionState !== TOOL_CANCELLATION_EXECUTION_STATES.notExecuted;
      }
      return true;
    });
    const notes = ["本轮因上下文窗口溢出而中断，未自动重放。"];
    if (producedText) {
      notes.push("本轮已产生部分文本，持久历史仅保留此中断标记。");
    }
    if (hadToolActivity) {
      notes.push("本轮已有操作开始执行，部分结果可能已经生效且不会自动撤销，请先检查实际结果。");
    }
    const uncoveredRecords = [...this.uncoveredToolExecutions.values()];
    this.appendInterruptedTurnMessages(queue, activeTurn, turnStartedAt, {
      rollbackTo: this.messages.length,
      messages: [
        ...(activeTurn.userMessagePersisted ? [] : [userMessage]),
        ...(uncoveredRecords.length === 0
          ? []
          : [createToolLedgerGapRecoveryMessage(uncoveredRecords)]),
        { role: "assistant", content: notes.join("") },
      ],
      debugLabel: "persisting context-overflow marker",
      debugDetails: { hadToolActivity, producedText },
      failureLabel: "上下文溢出记录持久化失败",
    });
  }

  private persistFailedTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    userMessage: UserModelMessage,
    turnStartedAt: number,
  ): void {
    if (this.closed) {
      return;
    }
    const completedMessages = completedStepMessages(activeTurn);
    const hadProgress =
      completedMessages.length > 0 ||
      activeTurn.toolExecutions.length > 0 ||
      activeTurn.pendingToolCalls.size > 0;
    if (!hadProgress) {
      return;
    }
    const unpersistedMessages = repairActiveToolProtocol(
      stripReasoningMessages(unpersistedStepMessages(activeTurn)),
    ).messages;
    if (
      !this.persistPendingToolCancellationsOrReport(queue, activeTurn, "取消工具账本持久化失败")
    ) {
      return;
    }
    this.appendInterruptedTurnMessages(queue, activeTurn, turnStartedAt, {
      rollbackTo: this.messages.length,
      messages: [
        ...(activeTurn.userMessagePersisted ? [] : [userMessage]),
        ...unpersistedMessages,
        createCancelledTurnRecoveryMessage({
          context: this.failedTurnContextMessage(activeTurn),
          completedMessages,
          toolExecutions: activeTurn.toolExecutions,
        }),
        { role: "assistant", content: this.failedTurnDisplayMessage(activeTurn) },
      ],
      debugLabel: "persisting failed turn",
      failureLabel: "失败状态持久化失败",
    });
  }

  private failedTurnContextMessage(activeTurn: ActiveTurn): string {
    const execSessionIds = this.cancellationActivity(activeTurn).execSessionIds;
    const taskNumbers =
      execSessionIds.length > 0 ? `本轮后台任务编号: ${execSessionIds.join(", ")}。` : "";
    return `本轮因运行错误中断，未自动重试。${taskNumbers}已完成的步骤和工具记录仍然有效，不要自动重复 outcome=success 的操作。${INTERRUPTED_TURN_RECOVERY_POLICY}`;
  }

  private failedTurnDisplayMessage(activeTurn: ActiveTurn): string {
    const activity = this.cancellationActivity(activeTurn);
    const resultCheck = activity.hadPotentialSideEffects
      ? "部分操作可能已经生效且不会自动撤销，请先检查实际结果，再决定是否继续。"
      : activity.hadInFlightWork
        ? "刚才的任务结果尚未确认，请先检查后再继续。"
        : "你可以继续输入或重试。";
    return `本轮因运行错误而中断，未自动重试。之前的对话和已完成进度会保留。${resultCheck}`;
  }

  private appendInterruptedTurnMessages(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    turnStartedAt: number,
    input: {
      readonly rollbackTo: number;
      readonly messages: readonly ModelMessage[];
      readonly debugLabel: string;
      readonly debugDetails?: Record<string, unknown>;
      readonly failureLabel: string;
    },
  ): boolean {
    if (activeTurn.pendingToolCalls.size > 0) {
      queue.push({
        type: "error",
        stage: "execute",
        message: `${input.failureLabel}: 存在未写入账本的待处理工具调用，已拒绝持久化中断记录`,
      });
      return false;
    }
    this.messages.push(...input.messages);
    this.debug(queue, "persist", input.debugLabel, turnStartedAt, {
      appendedMessages: this.messages.length - input.rollbackTo,
      ...input.debugDetails,
    });
    try {
      this.persistMessages(this.messages.slice(input.rollbackTo), "recovery_evidence");
      return true;
    } catch (error) {
      this.messages.splice(input.rollbackTo);
      queue.push({
        type: "error",
        stage: "execute",
        message: `${input.failureLabel}: ${errorMessage(error)}`,
      });
      return false;
    }
  }

  private persistToolExecution(record: ToolExecutionRecord, activeTurn: ActiveTurn): void {
    // Durable storage is the write-ahead boundary: never acknowledge the Tool Result
    // to the session event stream if its forensic record could not be persisted.
    this.onToolExecution?.(record);
    this.inMemoryToolExecutions.push(record);
    activeTurn.toolExecutions.push(record);
    this.uncoveredToolExecutions.set(record.id, record);
  }

  private interactionDeadlineMs(activeTurn: ActiveTurn, now: number): number {
    const turnExpiresAt =
      activeTurn.expiresAt === undefined
        ? Number.POSITIVE_INFINITY
        : Date.parse(activeTurn.expiresAt);
    return Math.min(
      now + DEFAULT_INTERACTION_TIMEOUT_MS,
      Number.isFinite(turnExpiresAt) ? turnExpiresAt : Number.POSITIVE_INFINITY,
    );
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

    const expiresAt =
      this.activeTurn === undefined
        ? undefined
        : new Date(this.interactionDeadlineMs(this.activeTurn, Date.now())).toISOString();
    this.emit({
      type: "confirmation-required",
      approvalId,
      agentName: request.agentName,
      toolName: request.toolName,
      input: request.input,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.explanation !== undefined ? { explanation: request.explanation } : {}),
      ...(request.sessionGrantLabel !== undefined
        ? { sessionGrantLabel: request.sessionGrantLabel }
        : {}),
      ...(request.diff !== undefined ? { diff: request.diff } : {}),
      ...(request.fullDiff !== undefined ? { fullDiff: request.fullDiff } : {}),
    });
    return decision;
  }

  approve(approvalId: string, scope?: "once" | "session"): boolean {
    return this.gate.resolve(approvalId, {
      approved: true,
      ...(scope !== undefined ? { scope } : {}),
    });
  }

  reject(approvalId: string, reason?: string): boolean {
    const resolved = this.gate.resolve(approvalId, {
      approved: false,
      ...(reason ? { reason } : {}),
    });
    if (resolved && this.activeTurn !== undefined) this.activeTurn.userRejected = true;
    return resolved;
  }

  getMessages(): readonly ModelMessage[] {
    return stripExplicitSkillCheckpoints(stripCancelledTurnRecoveryMessages(this.messages));
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

  /** Process-local numeric estimates; not durable diagnostics or a public Runtime wire event. */
  getRequestBudgetState() {
    return this.requestBudgets.view();
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

  canSwitchModel(): boolean {
    return this.activeTurn === undefined;
  }

  switchModel(input: SessionModelSwitch): void {
    if (!this.canSwitchModel()) {
      throw new Error("会话正在生成回复，稍后再切换模型");
    }
    this.model = input.model;
    this.modelRecovery = input.modelRecovery;
    this.requestBudgets = new RequestBudgetTracker();
    this.contextWindowSource = input.contextWindowSource;
    this.contextWindow = input.contextWindow;
    this.providerOptions = input.providerOptions;
    this.structuredOutputProviderOptions = input.structuredOutputProviderOptions;
    this.structuredOutputReasoning = input.structuredOutputReasoning;
    this.lastInputTokens = undefined;
    this.measuredProjectedTokens = undefined;
    this.promptOverhead = undefined;
    if (input.toolSchemaPolicy !== undefined) {
      this.toolSchemaPolicy = input.toolSchemaPolicy;
      if (this.applyToolSchemaPolicy()) {
        this.refreshCapabilityManifest();
      }
    }
  }

  private modelTools(): ToolSet {
    if (this.excludedToolIds.size === 0) {
      return this.tools;
    }
    const excluded = this.excludedToolIds;
    return Object.fromEntries(Object.entries(this.tools).filter(([id]) => !excluded.has(id)));
  }

  private recordToolSchemaIssues(
    issuesByToolId: Readonly<Record<string, readonly JsonSchemaRefIssue[]>>,
  ): void {
    for (const [id, issues] of Object.entries(issuesByToolId)) {
      this.agentToolSchemaIssues.set(id, issues);
    }
  }

  private applyToolSchemaPolicy(): boolean {
    const policy = this.toolSchemaPolicy;
    const next = new Set<string>();
    if (policy) {
      for (const [id, issues] of this.agentToolSchemaIssues) {
        if (!policy(issues)) {
          next.add(id);
        }
      }
    }
    const previous = this.excludedToolIds;
    const changed = next.size !== previous.size || [...next].some((id) => !previous.has(id));
    for (const id of next) {
      if (!previous.has(id)) {
        const route = this.registry.resolve(id);
        this.onToolExcluded?.({
          toolId: id,
          agentName: route?.agentName ?? "",
          toolName: route?.toolName ?? id,
          issues: this.agentToolSchemaIssues.get(id) ?? [],
        });
      }
    }
    this.excludedToolIds = next;
    return changed;
  }

  private stopOnContextPressure(
    activeTurn: ActiveTurn,
    lastPreparedComparableTokens: () => number,
    predictFullRequest?: () => number | undefined,
    canRetryAdvisory: (tokens: number) => boolean = () => true,
  ): StopCondition<ToolSet> {
    return ({ steps }) => {
      const settings = this.compaction;
      const last = steps.at(-1);
      if (
        settings === undefined ||
        !settings.enabled ||
        this.contextWindow === undefined ||
        last === undefined ||
        last.finishReason !== "tool-calls" ||
        (steps.length < 2 && this.messages.length < 2) ||
        last.toolResults.some(
          (result) => readToolOutcome(result.output).kind === TOOL_OUTCOME_KINDS.userRejected,
        )
      ) {
        return false;
      }
      const usage = toSessionUsage(last.usage);
      const projected = estimateMessagesTokens(
        this.projectModelMessages([
          ...this.messages,
          ...canonicalMessagesForSteps(activeTurn, steps),
        ]),
      );
      const pressure =
        predictFullRequest?.() ??
        (usage.inputTokens === undefined
          ? this.promptOverheadTokens() + projected
          : Math.max(0, usage.inputTokens + projected - lastPreparedComparableTokens()));
      if (pressure / this.contextWindow < settings.threshold || !canRetryAdvisory(pressure)) {
        return false;
      }
      activeTurn.pausedForContextPressure = true;
      return true;
    };
  }

  private contextPressureTokens(pendingContent?: UserModelMessage["content"]): number {
    const pending =
      pendingContent === undefined
        ? 0
        : estimateMessagesTokens([{ role: "user", content: pendingContent }]);
    const projected = estimateMessagesTokens(this.projectModelMessages(this.messages));
    if (this.lastInputTokens !== undefined && this.measuredProjectedTokens !== undefined) {
      return Math.max(0, this.lastInputTokens + projected - this.measuredProjectedTokens + pending);
    }
    return this.promptOverheadTokens() + projected + pending;
  }

  private observationResultId(toolCallId: string): string | undefined {
    if (this.observationResultIds.has(toolCallId)) return this.observationResultIds.get(toolCallId);
    const matches = this.listPersistedToolExecutions?.({ toolCallId, limit: 2 }) ?? [];
    if (matches.length > 1) this.ambiguousObservationCallIds.add(toolCallId);
    const id = matches.length === 1 ? matches[0]?.id : undefined;
    this.observationResultIds.set(toolCallId, id);
    return id;
  }

  private readObservation(input: ObservationRecallInput): unknown {
    const record =
      this.getPersistedToolExecution?.(input.resultId) ??
      (() => {
        const sequence = this.inMemoryToolExecutions.findIndex(
          (candidate) => candidate.id === input.resultId,
        );
        const candidate = this.inMemoryToolExecutions[sequence];
        return candidate ? { ...candidate, sequence } : undefined;
      })();
    if (!record) throw new Error("当前会话中没有这个工具结果");
    const declaration = [...this.observationRetentionByToolId].find(([id]) => {
      const route = this.registry.resolve(id);
      return route?.agentName === record.agentName && route.toolName === record.toolName;
    })?.[1];
    if (!declaration) throw new Error("该结果不是可回查的浏览器观察");
    return readObservationPage(
      input,
      record,
      [...this.messages, ...(this.activeTurn ? unpersistedStepMessages(this.activeTurn) : [])],
      declaration,
      this.observationResultId(record.toolCallId) === record.id,
    );
  }

  private projectModelMessages(messages: readonly ModelMessage[]): ModelMessage[] {
    const projected = projectObservationMessages(messages, {
      declarations: this.observationRetentionByToolId,
      resultId: (toolCallId) => this.observationResultId(toolCallId),
      ...(this.observationRecallToolId ? { recallToolId: this.observationRecallToolId } : {}),
    });
    return projected;
  }

  private promptOverheadTokens(): number {
    const reminder = this.currentCheckpointReminder(
      findCapabilityToolId(this.capabilityManifest, CAPABILITY_TOOL_ROLES.transcriptRead),
    );
    return (this.promptOverhead ?? 0) + (reminder === undefined ? 0 : estimateTextTokens(reminder));
  }

  private currentCheckpointReminder(transcriptToolId: string | undefined): string | undefined {
    return this.compactionCheckpoint === undefined
      ? undefined
      : buildCompactionCheckpointReminder(
          this.compactionCheckpoint,
          this.sessionManagerInstanceId,
          transcriptToolId,
        );
  }

  private persistPausedTurnCancellation(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    turnStartedAt: number,
  ): void {
    if (
      !this.persistPendingToolCancellationsOrReport(queue, activeTurn, "取消工具账本持久化失败")
    ) {
      activeTurn.cancellationPersistenceAttempted = true;
      this.emitCancellation(queue, activeTurn);
      return;
    }
    if (!activeTurn.cancellationPersistenceAttempted && !this.closed) {
      activeTurn.cancellationPersistenceAttempted = true;
      activeTurn.cancellationPersisted = true;
      const records = this.cancellationRecordMessages(
        activeTurn,
        completedStepMessages(activeTurn),
      );
      activeTurn.cancellationPersisted = this.appendInterruptedTurnMessages(
        queue,
        activeTurn,
        turnStartedAt,
        {
          rollbackTo: this.messages.length,
          messages: records,
          debugLabel: "persisting paused turn cancellation",
          failureLabel: "取消状态持久化失败",
        },
      );
    }
    this.emitCancellation(queue, activeTurn);
  }

  private compactionTargetTokens(pendingContent?: UserModelMessage["content"]): number | undefined {
    const settings = this.compaction;
    if (settings === undefined || this.contextWindow === undefined) {
      return undefined;
    }
    const pending =
      pendingContent === undefined
        ? 0
        : estimateMessagesTokens([{ role: "user", content: pendingContent }]);
    return Math.max(
      1,
      Math.floor(this.contextWindow * settings.threshold) - this.promptOverheadTokens() - pending,
    );
  }

  private listCompactionTranscriptEvidence(): readonly ArchivedTranscriptMessage[] {
    const list = this.listPersistedTranscriptMessages;
    const project = (entry: ArchivedTranscriptMessage): ArchivedTranscriptMessage => ({
      ...entry,
      message: projectTurnInputSkillCheckpoint(
        entry.message,
        this.getInputSkillCheckpoint?.(entry.sequence) ??
          this.inputSkillCheckpoints.get(entry.sequence),
      ),
    });
    if (list === undefined) {
      return this.inMemoryTranscript.map(project);
    }
    const entries: ArchivedTranscriptMessage[] = [];
    let afterSequence = -1;
    while (true) {
      const page = list({ afterSequence, limit: 500 });
      entries.push(...page.map(project));
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

  private async runCompactionTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    reason: ContextCompactionReason,
  ): Promise<void> {
    try {
      this.reconcileUncoveredToolExecutionContext();
      await this.runCompaction(queue, reason, activeTurn, true, this.compactionTargetTokens());
    } catch (error) {
      if (this.isTurnAborted(activeTurn)) this.emitCancellation(queue, activeTurn);
      else queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
    } finally {
      if (this.activeTurn === activeTurn) this.activeTurn = undefined;
      queue.close();
    }
  }

  private async runCompaction(
    queue: AsyncEventQueue<SessionEvent>,
    reason: ContextCompactionReason,
    activeTurn: ActiveTurn | undefined,
    emitCancellationOnAbort: boolean,
    targetTokens: number | undefined,
    projectRequest?: (
      messages: readonly ModelMessage[],
      reminder: string | undefined,
    ) => readonly ModelMessage[],
  ): Promise<boolean> {
    const startedAt = Date.now();
    const beforeInputTokens = this.lastInputTokens;
    const settings = this.compaction;
    const strategy = settings?.strategy ?? "summarize";
    queue.push({ type: "compaction-start", reason });
    const noChange = (): false => {
      queue.push({
        type: "context-compacted",
        ...(beforeInputTokens === undefined ? {} : { beforeInputTokens }),
        reason,
        strategy,
        removed: 0,
        kept: this.messages.length,
        ...(reason === "manual"
          ? { recoveryNotice: "当前内容未产生可用的压缩，已保留原上下文。" }
          : {}),
      });
      return false;
    };
    if (this.isTurnAborted(activeTurn)) {
      if (emitCancellationOnAbort && activeTurn) this.emitCancellation(queue, activeTurn);
      return noChange();
    }
    if (!settings) return noChange();
    try {
      const expectedActiveMessages = [...this.messages];
      const previousCheckpoint = this.compactionCheckpoint;
      const transcriptToolId = findCapabilityToolId(
        this.capabilityManifest,
        CAPABILITY_TOOL_ROLES.transcriptRead,
      );
      const previousSummary =
        previousCheckpoint === undefined
          ? undefined
          : previousCheckpoint.version === 3
            ? previousCheckpoint.taskSummary
            : buildCompactionCheckpointReminder(
                previousCheckpoint,
                this.sessionManagerInstanceId,
                transcriptToolId,
              );
      const result = await compactMessages({
        messages: expectedActiveMessages,
        strategy,
        keepRecentTurns: settings.keepRecentTurns,
        keepRecentTokens: settings.keepRecentTokens,
        model: this.model,
        ...(previousSummary === undefined ? {} : { previousSummary }),
        ...(targetTokens === undefined ? {} : { targetTokens }),
        ...(this.contextWindow === undefined ? {} : { contextWindow: this.contextWindow }),
        ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
        ...(settings.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: settings.maxOutputTokens }),
        ...(this.structuredOutputReasoning === undefined
          ? {}
          : { structuredOutputReasoning: this.structuredOutputReasoning }),
        ...(this.structuredOutputProviderOptions === undefined
          ? {}
          : { structuredOutputProviderOptions: this.structuredOutputProviderOptions }),
        ...(activeTurn === undefined ? {} : { abortSignal: activeTurn.abortController.signal }),
      });
      if (this.isTurnAborted(activeTurn)) {
        if (emitCancellationOnAbort && activeTurn) this.emitCancellation(queue, activeTurn);
        return noChange();
      }
      if (result.removed === 0) return noChange();
      // Explicit legacy truncate remains an opt-in policy; summary failures never use it.
      const summary =
        result.summary ??
        (strategy === "truncate"
          ? (previousSummary ??
            "Earlier messages were archived. Consult the original transcript for historical details.")
          : undefined);
      if (summary === undefined || summary.trim().length === 0) return noChange();
      const projected = repairActiveToolProtocol(result.messages);
      if (projected.status === ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS.repaired) return noChange();
      const beforeReminder = this.currentCheckpointReminder(transcriptToolId);
      const tokens = (messages: readonly ModelMessage[], reminder: string | undefined): number =>
        projectRequest === undefined
          ? this.requestBudgets.projectedMessageTokens(
              buildSessionModelRequest({
                history: messages,
                explicitSkill: { skillNames: [], userPrompt: "", modelUserContent: "" },
                capabilityReminder: "",
                ...(reminder === undefined ? {} : { checkpointReminder: reminder }),
                system: this.systemPrompt,
                tools: this.modelTools(),
                project: (history) => this.projectModelMessages(history),
              }).messages,
            )
          : this.requestBudgets.projectedMessageTokens(projectRequest(messages, reminder));
      // System, tool schemas and options are unchanged; compare the entire changing
      // request projection (including the new reminder) on the same uncalibrated basis.
      const before = tokens(expectedActiveMessages, beforeReminder);
      const noProgress = new Error("compaction_candidate_did_not_shrink");
      let after = before;
      const validateCheckpoint = (checkpoint: CompactionCheckpoint): void => {
        const reminder = buildCompactionCheckpointReminder(
          checkpoint,
          this.sessionManagerInstanceId,
          transcriptToolId,
        );
        after = tokens(result.messages, reminder);
        if (after >= before) throw noProgress;
      };
      let checkpoint: CompactionCheckpoint;
      try {
        if (this.commitPersistedCompaction) {
          // Store validates this exact candidate inside the same CAS transaction before
          // changing checkpoint/history. Persisted metadata can differ from local estimates.
          checkpoint = this.commitPersistedCompaction({
            messages: result.messages,
            expectedActiveMessages,
            expectedLatestCheckpointId: previousCheckpoint?.id,
            summary,
            validateCheckpoint,
          });
        } else {
          const transcript = this.listCompactionTranscriptEvidence();
          const records = this.listCompactionToolEvidence();
          const candidate = createSummaryCheckpoint({
            summary,
            generation: (previousCheckpoint?.generation ?? 0) + 1,
            ...(previousCheckpoint ? { previousCheckpointId: previousCheckpoint.id } : {}),
            transcript: {
              messages: {
                fromSequenceExclusive: -1,
                throughSequence:
                  transcript.at(-1)?.sequence ??
                  previousCheckpoint?.transcript.messages.throughSequence ??
                  -1,
              },
              toolExecutions: {
                fromSequenceExclusive: -1,
                throughSequence:
                  records.at(-1)?.sequence ??
                  previousCheckpoint?.transcript.toolExecutions.throughSequence ??
                  -1,
              },
              completeness: previousCheckpoint?.transcript.completeness ?? "complete",
            },
            toolState: buildCompactionToolState(
              transcript.map((entry) => entry.message),
              records,
            ),
          });
          validateCheckpoint(candidate);
          this.onReplace?.(result.messages);
          checkpoint = candidate;
        }
      } catch (error) {
        if (error === noProgress) return noChange();
        throw error;
      }
      this.messages.splice(0, this.messages.length, ...result.messages);
      this.compactionCheckpoint = checkpoint;
      this.lastInputTokens = undefined;
      this.measuredProjectedTokens = undefined;
      queue.push({
        type: "context-compacted",
        ...(beforeInputTokens === undefined ? {} : { beforeInputTokens }),
        reason,
        strategy,
        removed: result.removed,
        kept: result.kept,
        checkpointId: checkpoint.id,
        checkpointGeneration: checkpoint.generation,
        checkpointSummaryStatus: strategy === "summarize" ? "valid" : "skipped",
      });
      this.debug(queue, "compaction", "task summary committed", startedAt, {
        removed: result.removed,
        kept: result.kept,
        beforeEstimatedTokens: before,
        afterEstimatedTokens: after,
      });
      return true;
    } catch (error) {
      noChange();
      throw error;
    }
  }

  private async recoverFromContextError(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn?: ActiveTurn,
  ): Promise<boolean> {
    if (!this.compaction?.enabled) return false;
    try {
      return await this.runCompaction(
        queue,
        "auto",
        activeTurn,
        false,
        this.compactionTargetTokens(),
      );
    } catch (error) {
      if (!this.isTurnAborted(activeTurn)) {
        queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
      }
      return false;
    }
  }

  private isTurnAborted(activeTurn: ActiveTurn | undefined): boolean {
    return activeTurn?.aborted === true || activeTurn?.abortController.signal.aborted === true;
  }

  private execSessionIds(activeTurn: ActiveTurn): readonly number[] {
    return [...activeTurn.execSessionIds].sort((left, right) => left - right);
  }

  private activeExecSessionIds(activeTurn: ActiveTurn): readonly number[] {
    return this.execSessionIds(activeTurn).filter((sessionId) => {
      const session = this.sessionManager?.get(sessionId);
      return session !== undefined && !isTerminalSessionState(session.state);
    });
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
    this.captureCancellationActivity(activeTurn);
    activeTurn.aborted = true;
    activeTurn.cancellationReason ??= SESSION_CANCELLATION_REASONS.runtime;
    this.gate.abortAll("本轮事件流已停止");
    this.userInputInteractions.cancelAll("本轮事件流已停止");
    this.interruptExecSessions(activeTurn);
    activeTurn.abortController.abort(RUNTIME_CANCELLATION_ABORT_REASON);
  }

  private currentCancellationActivity(activeTurn: ActiveTurn): TurnCancellationActivity {
    const execSessionIds = this.activeExecSessionIds(activeTurn);
    const startedToolCalls = [...activeTurn.pendingToolCalls.values()].filter((pending) =>
      this.toolCoordinator.hasExecutionStarted(pending.executionOccurrence),
    );
    return {
      execSessionIds,
      hadCompletedProgress:
        activeTurn.toolExecutions.length > 0 || activeTurn.completedStepResponses.size > 0,
      hadInFlightWork: startedToolCalls.length > 0 || execSessionIds.length > 0,
      hadPotentialSideEffects:
        activeTurn.hadPotentialSideEffects ||
        startedToolCalls.some((pending) => pending.potentialSideEffect),
    };
  }

  private captureCancellationActivity(activeTurn: ActiveTurn): void {
    activeTurn.cancellationActivity ??= this.currentCancellationActivity(activeTurn);
  }

  private cancellationActivity(activeTurn: ActiveTurn): TurnCancellationActivity {
    return activeTurn.cancellationActivity ?? this.currentCancellationActivity(activeTurn);
  }

  private cancellationDisplayMessage(activeTurn: ActiveTurn): string {
    const reason = activeTurn.cancellationReason ?? SESSION_CANCELLATION_REASONS.runtime;
    const activity = this.cancellationActivity(activeTurn);
    if (activeTurn.cancellationPersistenceAttempted && !activeTurn.cancellationPersisted) {
      const resultCheck = activity.hadPotentialSideEffects
        ? "部分操作可能已经执行，请先检查结果后再继续。"
        : activity.hadInFlightWork
          ? "刚才的任务结果尚未确认，请先检查后再继续。"
          : "请重新输入需要继续的内容。";
      const retention = activeTurn.userMessagePersisted
        ? "本轮输入已保存，但进度或中断记录未能保存。"
        : "刚才的对话和进度未能保存。";
      return reason === SESSION_CANCELLATION_REASONS.timeout
        ? `本轮等待时间过长，已自动停止。${retention}${resultCheck}`
        : reason === SESSION_CANCELLATION_REASONS.runtime
          ? `本轮因运行异常而中断。${retention}${resultCheck}`
          : `已停止本轮。${retention}${resultCheck}`;
    }
    const execSessionIds = activity.execSessionIds;
    const sessionListToolId = findCapabilityToolId(
      this.capabilityManifest,
      CAPABILITY_TOOL_ROLES.sessionList,
    );
    switch (reason) {
      case SESSION_CANCELLATION_REASONS.user:
        if (activity.hadInFlightWork) {
          return activity.hadPotentialSideEffects
            ? "已停止本轮操作。正在进行的任务也已请求停止。之前的对话和已完成进度会保留；部分已经完成的操作不会自动撤销，请检查结果。"
            : "已停止本轮操作。正在进行的任务也已请求停止。之前的对话和已完成进度会保留。";
        }
        if (activity.hadCompletedProgress) {
          return activity.hadPotentialSideEffects
            ? "已停止本轮回复。之前的对话和已完成进度会保留；部分已经完成的操作不会自动撤销，请检查结果。"
            : "已停止本轮回复。之前的对话和已完成进度会保留，你可以继续输入。";
        }
        return "已停止本轮回复。之前的对话会保留，你可以继续输入。";
      case SESSION_CANCELLATION_REASONS.timeout: {
        if (execSessionIds.length === 0) {
          return "本轮等待时间过长，已自动停止。之前的对话和已完成进度会保留，你可以继续输入或重试。";
        }
        if (isProcessBoundHostMode(this.capabilityManifest.lifecycle.hostMode)) {
          return "本轮等待时间过长，已自动停止。正在进行的任务会随本次命令结束而停止，之后无法继续查看；请先确认实际结果，再决定是否重试。";
        }
        if (sessionListToolId) {
          return `本轮等待时间过长，但任务仍在运行（任务 #${execSessionIds.join(", #")}）。你可以在下一条消息中继续查看进度；确认结果前请勿重复执行。`;
        }
        return "本轮等待时间过长。任务可能仍在运行，但 Roll 暂时无法继续查看进度；请先确认实际结果，再决定是否重试。";
      }
      case SESSION_CANCELLATION_REASONS.runtime:
        if (activity.hadInFlightWork) {
          return "本轮因运行异常而中断。正在进行的任务已请求停止，最终结果尚未确认；请检查结果后再继续。";
        }
        return activity.hadPotentialSideEffects
          ? "本轮因运行异常而中断。之前的对话和已完成进度会保留；部分已经完成的操作不会自动撤销，请检查结果后再继续。"
          : "本轮因运行异常而中断。之前的对话会保留，你可以重试。";
    }
  }

  private cancellationContextMessage(activeTurn: ActiveTurn): string {
    const reason = activeTurn.cancellationReason ?? SESSION_CANCELLATION_REASONS.runtime;
    const execSessionIds = this.cancellationActivity(activeTurn).execSessionIds;
    const taskNumbers =
      execSessionIds.length > 0 ? `本轮后台任务编号: ${execSessionIds.join(", ")}。` : "";
    const sessionListToolId = findCapabilityToolId(
      this.capabilityManifest,
      CAPABILITY_TOOL_ROLES.sessionList,
    );
    const recoveryPolicy = INTERRUPTED_TURN_RECOVERY_POLICY;
    switch (reason) {
      case SESSION_CANCELLATION_REASONS.user:
        return `用户主动停止了本轮。${taskNumbers}这些任务已收到停止请求；已完成的步骤和工具记录仍然有效，不要自动重复 outcome=success 的操作。${recoveryPolicy}`;
      case SESSION_CANCELLATION_REASONS.timeout: {
        const duration =
          this.turnTimeoutMs !== undefined ? `（${String(this.turnTimeoutMs)}ms）` : "";
        if (execSessionIds.length === 0) {
          return `本轮因超时${duration}停止。已完成的步骤和工具记录仍然有效。${recoveryPolicy}`;
        }
        if (isProcessBoundHostMode(this.capabilityManifest.lifecycle.hostMode)) {
          return `本轮因超时${duration}停止。${taskNumbers}当前 one-shot 进程结束时会清理这些任务，后续 CLI 进程无法恢复。${recoveryPolicy}`;
        }
        if (sessionListToolId) {
          return `本轮因超时${duration}停止，但后台任务仍在当前进程运行。${taskNumbers}若且仅若最新用户明确要求继续或核对上一任务，可用 ${sessionListToolId} 找回并查看。${recoveryPolicy}`;
        }
        return `本轮因超时${duration}停止，但后台任务可能仍在运行。${taskNumbers}当前没有可用的任务列表工具，不能安全恢复查看。${recoveryPolicy}`;
      }
      case SESSION_CANCELLATION_REASONS.runtime:
        return `本轮因运行异常中断。${taskNumbers}已完成的步骤和工具记录仍然有效。${recoveryPolicy}`;
    }
  }

  private emitCancellation(queue: AsyncEventQueue<SessionEvent>, activeTurn: ActiveTurn): void {
    if (activeTurn.cancellationEventEmitted) {
      return;
    }
    activeTurn.cancellationReason ??= SESSION_CANCELLATION_REASONS.runtime;
    activeTurn.cancellationEventEmitted = true;
    const execSessionIds = this.cancellationActivity(activeTurn).execSessionIds;
    queue.push({
      type: "turn-cancelled",
      reason: activeTurn.cancellationReason,
      message: this.cancellationDisplayMessage(activeTurn),
      ...(execSessionIds.length > 0 ? { execSessionIds } : {}),
    });
  }

  private persistCancelledRecoveryTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    userMessage: UserModelMessage,
    turnStartedAt: number,
  ): void {
    const turnStart = this.messages.length;
    if (!activeTurn.userMessagePersisted) {
      this.messages.push(userMessage);
    }
    this.persistCancelledTurn(
      queue,
      activeTurn,
      turnStart,
      turnStartedAt,
      INTERRUPTED_STEP_POLICIES.ledgerOnly,
    );
  }

  private persistCancelledTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    turnStart: number,
    turnStartedAt: number,
    stepPolicy: InterruptedStepPolicy = INTERRUPTED_STEP_POLICIES.keepRaw,
  ): void {
    if (
      !this.persistPendingToolCancellationsOrReport(queue, activeTurn, "取消工具账本持久化失败")
    ) {
      this.messages.splice(turnStart);
      activeTurn.cancellationPersistenceAttempted = true;
      this.emitCancellation(queue, activeTurn);
      return;
    }
    if (this.closed) {
      this.messages.splice(turnStart);
      activeTurn.cancellationPersistenceAttempted = true;
      this.emitCancellation(queue, activeTurn);
      return;
    }
    if (!activeTurn.cancellationPersistenceAttempted) {
      activeTurn.cancellationPersistenceAttempted = true;
      // turnStart is now the response boundary; accepted input is already durable before it.
      this.messages.splice(turnStart);
      const keepRaw = stepPolicy === INTERRUPTED_STEP_POLICIES.keepRaw;
      const appendedStepMessages = keepRaw
        ? repairActiveToolProtocol(stripReasoningMessages(unpersistedStepMessages(activeTurn)))
            .messages
        : [];
      const visibleStepMessages = keepRaw
        ? completedStepMessages(activeTurn)
        : persistedStepMessages(activeTurn);
      activeTurn.cancellationPersisted = true;
      const records = this.cancellationRecordMessages(activeTurn, visibleStepMessages);
      activeTurn.cancellationPersisted = this.appendInterruptedTurnMessages(
        queue,
        activeTurn,
        turnStartedAt,
        {
          rollbackTo: turnStart,
          messages: [...appendedStepMessages, ...records],
          debugLabel: "persisting cancelled turn",
          failureLabel: "取消状态持久化失败",
        },
      );
    }
    this.emitCancellation(queue, activeTurn);
  }

  private cancellationRecordMessages(
    activeTurn: ActiveTurn,
    completedMessages: readonly ModelMessage[],
  ): readonly ModelMessage[] {
    return [
      createCancelledTurnRecoveryMessage({
        context: this.cancellationContextMessage(activeTurn),
        completedMessages,
        toolExecutions: activeTurn.toolExecutions,
      }),
      createTurnCancellationMessage(
        this.cancellationDisplayMessage(activeTurn),
        activeTurn.cancellationReason ?? SESSION_CANCELLATION_REASONS.runtime,
      ),
    ];
  }

  private persistPendingToolCancellationsOrReport(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    failureLabel: string,
  ): boolean {
    this.captureCancellationActivity(activeTurn);
    try {
      this.persistPendingToolCancellations(queue, activeTurn);
      return true;
    } catch (error) {
      queue.push({
        type: "error",
        stage: "execute",
        message: `${failureLabel}: ${errorMessage(error)}`,
      });
      return false;
    }
  }

  /** Only called after the failed stream settles and every remaining occurrence is unstarted. */
  private persistRecoveryCancellations(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
  ): void {
    const messages: ModelMessage[] = [];
    for (const pending of activeTurn.pendingToolCalls.values()) {
      const result = createToolResult(
        {
          kind: TOOL_OUTCOME_KINDS.cancelled,
          reason: SESSION_CANCELLATION_REASONS.runtime,
          executionState: TOOL_CANCELLATION_EXECUTION_STATES.notExecuted,
        },
        "模型连接中断，本工具调用确定未执行；重新生成的调用仍需正常校验与审批。",
      );
      const record = createToolExecutionRecord({
        toolCallId: pending.toolCallId,
        agentName: pending.agentName,
        toolName: pending.toolName,
        input: pending.input,
        result,
      });
      this.persistToolExecution(record, activeTurn);
      queue.push({
        type: "tool-result",
        toolCallId: pending.toolCallId,
        agentName: pending.agentName,
        toolName: pending.toolName,
        executionId: record.id,
        outcome: result.outcome,
        display: result.display,
        output: result.display,
        isError: true,
      });
      const toolName = `${pending.agentName}__${pending.toolName}`;
      messages.push(
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: pending.toolCallId, toolName, input: pending.input },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: pending.toolCallId, toolName, output: result.model },
          ],
        },
      );
      activeTurn.pendingToolCalls.delete(pending.toolCallId);
    }
    if (messages.length > 0) {
      this.persistMessages(messages, "raw_transcript");
      this.messages.push(...messages);
    }
  }

  private persistPendingToolCancellations(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
  ): void {
    const cancellationReason =
      activeTurn.cancellationReason ?? SESSION_CANCELLATION_REASONS.runtime;
    for (const pending of activeTurn.pendingToolCalls.values()) {
      const executionState = this.toolCoordinator.hasExecutionStarted(pending.executionOccurrence)
        ? TOOL_CANCELLATION_EXECUTION_STATES.outcomeUnknown
        : TOOL_CANCELLATION_EXECUTION_STATES.notExecuted;
      const display =
        executionState === TOOL_CANCELLATION_EXECUTION_STATES.notExecuted
          ? `工具调用在开始执行前因本轮 ${cancellationReason} 中断而取消；确定未执行`
          : `工具调用已开始，因本轮 ${cancellationReason} 中断而取消；最终结果尚未确认`;
      const result = createToolResult(
        {
          kind: TOOL_OUTCOME_KINDS.cancelled,
          reason: cancellationReason,
          executionState,
        },
        display,
        {
          raw: {
            cancellationReason,
            executionState,
            abortReason: errorMessage(activeTurn.abortController.signal.reason),
          },
        },
      );
      const record = createToolExecutionRecord({
        toolCallId: pending.toolCallId,
        agentName: pending.agentName,
        toolName: pending.toolName,
        input: pending.input,
        result,
      });
      this.persistToolExecution(record, activeTurn);
      queue.push({
        type: "tool-result",
        toolCallId: pending.toolCallId,
        agentName: pending.agentName,
        toolName: pending.toolName,
        executionId: record.id,
        outcome: result.outcome,
        display: result.display,
        output: result.display,
        isError: true,
      });
      activeTurn.pendingToolCalls.delete(pending.toolCallId);
    }
  }

  cancel(): boolean {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return false;
    }
    this.captureCancellationActivity(activeTurn);
    activeTurn.aborted = true;
    activeTurn.cancellationReason = SESSION_CANCELLATION_REASONS.user;
    this.gate.abortAll("用户取消本轮");
    this.userInputInteractions.cancelAll("用户取消本轮");
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
      this.captureCancellationActivity(activeTurn);
      activeTurn.aborted = true;
      activeTurn.cancellationReason ??= SESSION_CANCELLATION_REASONS.runtime;
      this.gate.abortAll();
      this.userInputInteractions.cancelAll("Runtime 正在关闭");
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
