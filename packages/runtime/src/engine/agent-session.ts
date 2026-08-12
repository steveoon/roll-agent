import { createHash, randomUUID } from "node:crypto";
import { waitForPromiseSettlement } from "../bounded-wait.ts";
import { relocateToolImagesToUserMessages } from "./relocate-tool-images.ts";
import {
  buildUserMessageContent,
  normalizeSessionSendInput,
  redactBinaryPartsForEvidence,
  type NormalizedSessionSendInput,
  type SessionSendInput,
} from "./session-attachments.ts";
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
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { UserInputForm, UserInputResult } from "@roll-agent/protocol";
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
  stripTurnCancellationMetadata,
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
  type ToolCancellationExecutionState,
} from "../tool-bridge/normalize-result.ts";
import {
  createToolExecutionRecord,
  prepareToolExecutionRecordForPersistence,
  redactSecretText,
  toRedactedToolExecutionRecordSummary,
  type RedactedToolExecutionRecordSummary,
  type ToolExecutionRecord,
} from "../tool-bridge/tool-execution-record.ts";
import type {
  CompactionEvidenceWatermarks,
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
import {
  COMPACTION_DRAFT_FALLBACK_REASONS,
  compactMessages,
  CompactionDraftFallbackError,
  isCompactionSummaryAcknowledgement,
  readCompactionSummaryPayload,
} from "./compactor.ts";
import { AsyncEventQueue } from "./event-queue.ts";
import {
  applyExplicitSkillContext,
  attachExplicitSkillCheckpoint,
  prepareExplicitSkillContext,
  readExplicitSkillCheckpoint,
  stripExplicitSkillCheckpoints,
} from "./explicit-skill-context.ts";
import {
  createCancelledTurnRecoveryMessage,
  materializeCancelledTurnRecoveryMessages,
  stripCancelledTurnRecoveryMessages,
} from "./cancelled-turn-recovery.ts";
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
  COMPACTION_CHECKPOINT_VERSION,
  createCompactionCheckpoint,
  createCompactionSummary,
  createCheckpointSemanticReminderProjection,
  findLatestRealUserGoal,
  resolveActiveCompactionConstraints,
  TRANSCRIPT_MESSAGE_PROVENANCES,
  type ArchivedTranscriptMessage,
  type CompactionCheckpoint,
  type CompactionCheckpointDraftInput,
  type CompactionResource,
  type CompactionRunningWork,
  type CompactionSemanticEvidenceWatermarks,
  type CompactionSummary,
} from "./compaction-checkpoint.ts";
import {
  buildCompactionSemanticModelContext,
  buildCompactionSemanticEvidenceRegistry,
  mergeCompactionSemanticState,
  replaceCompactionSemanticConstraints,
  replaceCompactionSemanticGoal,
  renderCompactionSemanticSummary,
  seedCompactionSemanticConstraints,
  seedLegacyCompactionSnapshotUncertainties,
  validateCompactionModelDraft,
  type CompactionModelDraft,
  type CompactionSemanticEvidenceRegistry,
  type CompactionSemanticItemId,
  type CompactionSemanticState,
} from "./compaction-semantic-state.ts";
import {
  ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS,
  repairActiveToolProtocol,
} from "./tool-protocol-repair.ts";
import { buildTranscriptToolset, type TranscriptReader } from "../tool-bridge/transcript-tool.ts";
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
  readonly structuredOutputProviderOptions?: SharedV4ProviderOptions;
  readonly structuredOutputReasoning?: NonNullable<LanguageModelV4CallOptions["reasoning"]>;
  /** `setProviderOptions()` 生效后触发；ConversationEngine 用它同步子 Agent Sampling。 */
  readonly onProviderOptionsChange?: (providerOptions: SharedV4ProviderOptions | undefined) => void;
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
  readonly env?: NodeJS.ProcessEnv;
}

export type SessionSkillSummary = SkillSummary;

interface ActiveTurn {
  readonly abortController: AbortController;
  readonly execSessionIds: Set<number>;
  readonly pendingToolCalls: Map<string, PendingToolCall>;
  readonly completedStepResponses: Map<string, readonly ModelMessage[]>;
  readonly toolExecutions: ToolExecutionRecord[];
  expiresAt?: string;
  hadPotentialSideEffects: boolean;
  aborted: boolean;
  cancellationActivity?: TurnCancellationActivity;
  cancellationEventEmitted: boolean;
  cancellationPersistenceAttempted: boolean;
  cancellationPersisted: boolean;
  cancellationReason?: SessionCancellationReason;
}

interface PendingToolCall {
  readonly toolCallId: string;
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

interface CompactionDraftSnapshot {
  readonly draft: CompactionCheckpointDraftInput;
  readonly semanticState: CompactionSemanticState;
  readonly semanticSummaryText: string | undefined;
  readonly semanticRejectionCount: number;
  readonly legacySnapshotReminderCoverageComplete: boolean;
  readonly coveredEvidenceIds: readonly string[];
  readonly expectedActiveMessages: readonly ModelMessage[];
  readonly expectedLatestCheckpointId: string | undefined;
  readonly evidenceWatermarks: CompactionEvidenceWatermarks;
  readonly legacySnapshotTranscriptFragments: readonly string[];
}

interface CompactionEvidenceSnapshot {
  readonly transcript: readonly ArchivedTranscriptMessage[];
  readonly toolExecutions: readonly SequencedToolExecutionRecord[];
  readonly resources: readonly CompactionResource[];
  readonly runningWork: readonly CompactionRunningWork[];
  readonly completeness: "complete" | "legacy_snapshot";
  readonly goal: ReturnType<typeof findLatestRealUserGoal>;
  readonly newGoalSourceSequence: number | undefined;
  readonly previousSemanticState: CompactionSemanticState | undefined;
  readonly registry: CompactionSemanticEvidenceRegistry;
  readonly modelContext: string;
  readonly presentedEvidenceIds: readonly string[];
  readonly expectedActiveMessages: readonly ModelMessage[];
  readonly expectedLatestCheckpointId: string | undefined;
  readonly previousSemanticEvidenceWatermarks: CompactionSemanticEvidenceWatermarks;
  /** Derived legacy archive rows are already represented by semantic legacy_snapshot items. */
  readonly autoCoveredMessageSequences: ReadonlySet<number>;
  readonly legacySnapshotMigrationComplete: boolean;
  readonly legacySnapshotRequiredItemIds: readonly CompactionSemanticItemId[];
  readonly legacySnapshotTranscriptFragments: readonly string[];
  readonly legacySnapshotRemovableRawMessageCount: number;
  readonly evidenceWatermarks: CompactionEvidenceWatermarks;
}

interface LegacyV1ActiveSnapshot {
  readonly checkpointId: string;
  readonly messageFingerprints: readonly string[];
  readonly fragments: readonly string[];
  readonly removableRawMessageCount: number;
}

const SESSION_CLOSE_TIMEOUT_MS = 6_000;
const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_CONTEXT_RECOVERY_ATTEMPTS = 1;
const MAX_COMPACTION_RESOURCE_KEY_CHARS = 1_024;
const SERIALIZED_INVALID_TOOL_INPUT_PREFIX = "AI_InvalidToolInputError:";
const EMPTY_COMPACTION_MODEL_DRAFT = {
  startsNewGoalScope: false,
  goal: null,
  constraints: [],
  decisions: [],
  completedWork: [],
  pendingWork: [],
  resources: [],
  runningSessions: [],
  uncertainties: [],
  resolutions: [],
  evidenceReviews: [],
} as const satisfies CompactionModelDraft;

export type SessionToolExecutionRecordView =
  | SequencedToolExecutionRecord
  | (RedactedToolExecutionRecordSummary & { readonly sequence: number });

function boundedCompactionResourceKey(value: string): string {
  const characters = [...value];
  if (characters.length <= MAX_COMPACTION_RESOURCE_KEY_CHARS) {
    return value;
  }
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  const suffix = `…#${digest}`;
  return `${characters
    .slice(0, MAX_COMPACTION_RESOURCE_KEY_CHARS - [...suffix].length)
    .join("")}${suffix}`;
}

function createActiveTurn(): ActiveTurn {
  return {
    abortController: new AbortController(),
    execSessionIds: new Set<number>(),
    pendingToolCalls: new Map<string, PendingToolCall>(),
    completedStepResponses: new Map<string, readonly ModelMessage[]>(),
    toolExecutions: [],
    hadPotentialSideEffects: false,
    aborted: false,
    cancellationEventEmitted: false,
    cancellationPersistenceAttempted: false,
    cancellationPersisted: false,
  };
}

interface CompletedModelStep {
  readonly callId: string;
  readonly stepNumber: number;
  readonly response: { readonly messages: readonly ModelMessage[] };
}

function rememberCompletedStep(activeTurn: ActiveTurn, step: CompletedModelStep): void {
  activeTurn.completedStepResponses.set(`${step.callId}:${String(step.stepNumber)}`, [
    ...step.response.messages,
  ]);
}

function completedStepMessages(activeTurn: ActiveTurn): ModelMessage[] {
  return [...activeTurn.completedStepResponses.values()].flatMap((messages) => [...messages]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderCompactionMessageEvidence(entry: ArchivedTranscriptMessage): string {
  const explicitSkillCheckpoint = readExplicitSkillCheckpoint(entry.message);
  const [visibleMessage] = stripExplicitSkillCheckpoints([entry.message]);
  const message = visibleMessage ?? entry.message;
  const content =
    explicitSkillCheckpoint !== undefined && message.role === "user"
      ? explicitSkillCheckpoint.snapshot.userPrompt
      : typeof message.content === "string"
        ? message.content
        : JSON.stringify(redactBinaryPartsForEvidence(message.content));
  return `message ${String(entry.sequence)} ${message.role}: ${content}`;
}

function renderCompactionToolEvidenceValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function compactionToolEvidence(record: SequencedToolExecutionRecord): {
  readonly id: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly inputSummary: string;
  readonly resultSummary: string;
  readonly outcome: {
    readonly kind: string;
    readonly executionState?: ToolCancellationExecutionState;
  };
} {
  const persisted = prepareToolExecutionRecordForPersistence(record);
  return {
    id: record.id,
    agentName: record.agentName,
    toolName: record.toolName,
    inputSummary: renderCompactionToolEvidenceValue(persisted.input.value),
    resultSummary: renderCompactionToolEvidenceValue(persisted.model),
    outcome: {
      kind: record.outcome.kind,
      ...(record.outcome.kind === TOOL_OUTCOME_KINDS.cancelled &&
      record.outcome.executionState !== undefined
        ? { executionState: record.outcome.executionState }
        : {}),
    },
  };
}

function isDerivedCompactionReminderMessage(message: ModelMessage): boolean {
  return (
    (message.role === "user" &&
      typeof message.content === "string" &&
      readCompactionSummaryPayload(message.content) !== undefined) ||
    (message.role === "assistant" && isCompactionSummaryAcknowledgement(message.content))
  );
}

function createLegacyV1ActiveSnapshot(
  checkpointId: string,
  messages: readonly ModelMessage[],
): LegacyV1ActiveSnapshot {
  const fragments = messages.flatMap((message, index) => {
    if (message.role === "user" && typeof message.content === "string") {
      const summary = readCompactionSummaryPayload(message.content);
      if (summary !== undefined) {
        return summary.length === 0 ? [] : [redactSecretText(summary)];
      }
    }
    if (message.role === "assistant" && isCompactionSummaryAcknowledgement(message.content)) {
      return [];
    }
    return [
      redactSecretText(
        renderCompactionMessageEvidence({
          sequence: index,
          provenance: TRANSCRIPT_MESSAGE_PROVENANCES[1],
          createdAt: new Date(0).toISOString(),
          message,
        }),
      ),
    ];
  });
  return {
    checkpointId,
    messageFingerprints: messages.map((message) => JSON.stringify(message)),
    fragments,
    removableRawMessageCount: messages.filter(
      (message) => !isDerivedCompactionReminderMessage(message),
    ).length,
  };
}

function legacyV1ActiveSnapshotMatches(
  snapshot: LegacyV1ActiveSnapshot,
  checkpoint: CompactionCheckpoint | undefined,
  messages: readonly ModelMessage[],
): boolean {
  if (
    checkpoint?.version !== 1 ||
    checkpoint.id !== snapshot.checkpointId ||
    messages.length < snapshot.messageFingerprints.length
  ) {
    return false;
  }
  return snapshot.messageFingerprints.every(
    (fingerprint, index) => JSON.stringify(messages[index]) === fingerprint,
  );
}

function initialCompactionSemanticEvidenceWatermarks(
  checkpoint: CompactionCheckpoint | undefined,
): CompactionSemanticEvidenceWatermarks {
  if (checkpoint === undefined) {
    return { messagesThroughSequence: -1, toolExecutionsThroughSequence: -1 };
  }
  if (checkpoint.version === COMPACTION_CHECKPOINT_VERSION) {
    return checkpoint.semanticEvidence;
  }
  // V1 has no independent semantic watermark. Treat its durable transcript range as the
  // already-checkpointed boundary so archived evidence cannot consume the next model batch/cut
  // budget. In-memory restores seed their reconstructed transcript immediately after this range.
  return {
    messagesThroughSequence: checkpoint.transcript.messages.throughSequence,
    toolExecutionsThroughSequence: checkpoint.transcript.toolExecutions.throughSequence,
  };
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
  private readonly inMemoryTranscript: ArchivedTranscriptMessage[] = [];
  private readonly legacyV1ActiveSnapshot: LegacyV1ActiveSnapshot | undefined;
  private readonly compactionResources = new Map<string, CompactionResource>();
  private readonly contextWindow: number | undefined;
  private readonly compaction: SessionCompactionSettings | undefined;
  private readonly turnTimeoutMs: number | undefined;
  private readonly onClose: (() => void) | undefined;
  private providerOptions: SharedV4ProviderOptions | undefined;
  private readonly structuredOutputProviderOptions: SharedV4ProviderOptions | undefined;
  private readonly structuredOutputReasoning:
    | NonNullable<LanguageModelV4CallOptions["reasoning"]>
    | undefined;
  private readonly onProviderOptionsChange:
    | ((providerOptions: SharedV4ProviderOptions | undefined) => void)
    | undefined;
  private readonly debugEvents: boolean;
  private readonly policy: ToolPolicy | undefined;
  private systemPrompt: string;
  private readonly explicitSystemPrompt: string | undefined;
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
  private readonly gate = new ApprovalGate();
  private readonly userInputInteractions = new UserInputInteractionManager();
  private readonly toolCoordinator = new ToolExecutionCoordinator();
  private tools: ToolSet;
  private readonly registry: ToolRegistry;
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
  private needsCompaction = false;

  constructor(options: AgentSessionOptions) {
    this.id = options.id;
    this.model = options.model;
    this.maxSteps = options.maxSteps;
    const initialMessages = options.initialMessages
      ? stripReasoningMessages(options.initialMessages)
      : [];
    this.messages = [...repairActiveToolProtocol(initialMessages).messages];
    this.legacyV1ActiveSnapshot =
      options.initialCheckpoint?.version === 1
        ? createLegacyV1ActiveSnapshot(options.initialCheckpoint.id, this.messages)
        : undefined;
    this.onPersist = options.onPersist;
    this.onReplace = options.onReplace;
    this.onToolExecution = options.onToolExecution;
    this.listPersistedToolExecutions = options.listToolExecutions;
    this.getPersistedToolExecution = options.getToolExecution;
    this.listPersistedTranscriptMessages = options.listTranscriptMessages;
    this.commitPersistedCompaction = options.commitCompaction;
    this.compactionCheckpoint = options.initialCheckpoint;
    let initialTranscriptSequence =
      initialCompactionSemanticEvidenceWatermarks(options.initialCheckpoint)
        .messagesThroughSequence + 1;
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
    for (const resource of options.initialCheckpoint?.resources ?? []) {
      this.retainCompactionResource(resource);
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
    this.resolveDynamicCapabilityContext = options.resolveDynamicCapabilityContext;
    this.skillLibrary = options.skillLibrary;
    this.skillSummaries = options.skillLibrary?.list() ?? [];
    this.toolSourceAgentNames = new Set(options.sources.map((source) => source.agentName));
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
    let turnStart: number | undefined;
    let turnTimeout: ReturnType<typeof setTimeout> | undefined;
    const userMessageContent = buildUserMessageContent(input.text, input.attachments);
    try {
      this.debug(queue, "turn", "start", turnStartedAt, {
        messages: this.messages.length,
        tools: Object.keys(this.tools).length,
        maxSteps: this.maxSteps,
        ...(input.attachments.length > 0 ? { attachments: input.attachments.length } : {}),
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
        this.messages.push({ role: "user", content: userMessageContent });
        this.persistCancelledTurn(queue, activeTurn, turnStart, [], turnStartedAt);
        return;
      }

      queue.push({ type: "message-start", messageId: randomUUID() });
      if (this.turnTimeoutMs !== undefined) {
        activeTurn.expiresAt = new Date(Date.now() + this.turnTimeoutMs).toISOString();
        turnTimeout = setTimeout(() => {
          if (activeTurn.abortController.signal.aborted) {
            return;
          }
          this.captureCancellationActivity(activeTurn);
          activeTurn.aborted = true;
          activeTurn.cancellationReason = SESSION_CANCELLATION_REASONS.timeout;
          this.gate.abortAll("本轮运行超时");
          this.userInputInteractions.cancelAll("本轮运行超时");
          activeTurn.abortController.abort(TURN_TIMEOUT_ABORT_REASON);
        }, this.turnTimeoutMs);
      }
      let contextRecoveryAttempts = 0;
      const explicitSkillContext = prepareExplicitSkillContext({
        rawInput: input.text,
        skillSummaries: this.skillSummaries,
        skillLibrary: this.skillLibrary,
      });
      const rawUserMessage: UserModelMessage = { role: "user", content: userMessageContent };
      const storedUserMessage =
        explicitSkillContext.skillNames.length > 0
          ? attachExplicitSkillCheckpoint(rawUserMessage, explicitSkillContext)
          : rawUserMessage;
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
          this.messages.push(storedUserMessage);
          activeTurn.cancellationReason = resolveCancellationReason(
            activeTurn.cancellationReason,
            activeTurn.abortController.signal.reason ?? error,
          );
          this.persistCancelledTurn(queue, activeTurn, turnStart, [], turnStartedAt);
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
        // Persist checkpoints for recovery bookkeeping, but only the in-memory snapshot for this
        // ActiveTurn may become model-visible. Completed-turn Skill bodies stay out of history.
        const inferenceHistory = stripExplicitSkillCheckpoints(
          stripTurnCancellationMetadata(materializeCancelledTurnRecoveryMessages(this.messages)),
        );
        const inferenceMessages = prependLastUserContext(
          explicitSkillContext.skillNames.length > 0
            ? applyExplicitSkillContext(inferenceHistory, explicitSkillContext)
            : inferenceHistory,
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
            prepareStep: ({ messages }) => ({
              messages: relocateToolImagesToUserMessages(messages),
            }),
            stopWhen: [stepCountIs(this.maxSteps), stopOnUserRejected()],
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
            onStepEnd: (step) => {
              rememberCompletedStep(activeTurn, step);
              abortedResponseMessages = completedStepMessages(activeTurn);
            },
            onAbort: ({ steps }) => {
              for (const step of steps) {
                rememberCompletedStep(activeTurn, step);
              }
              abortedResponseMessages = completedStepMessages(activeTurn);
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
                if (
                  pending?.potentialSideEffect === true &&
                  outcome.kind !== TOOL_OUTCOME_KINDS.userRejected &&
                  outcome.kind !== TOOL_OUTCOME_KINDS.policyDenied &&
                  outcome.kind !== TOOL_OUTCOME_KINDS.invalidInput
                ) {
                  activeTurn.hadPotentialSideEffects = true;
                }
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
              : "；本次尝试已有内容或操作开始执行，为避免重复执行，未自动重试";
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
              : "；本次尝试已有内容或操作开始执行，为避免重复执行，未自动重试";
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
        this.persistMessages(this.messages.slice(turnStart));
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

  private persistMessages(messages: readonly ModelMessage[]): void {
    this.onPersist?.(messages);
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
      notes.push("本轮已有操作开始执行，部分结果可能已经生效且不会自动撤销，请先检查实际结果。");
    }
    const start = this.messages.length;
    this.messages.push(userMessage);
    this.messages.push({ role: "assistant", content: notes.join("") });
    this.debug(queue, "persist", "persisting context-overflow marker", turnStartedAt, {
      hadToolActivity,
      producedText,
    });
    try {
      this.persistMessages(this.messages.slice(start));
    } catch (error) {
      this.messages.splice(start);
      queue.push({
        type: "error",
        stage: "execute",
        message: `上下文溢出记录持久化失败: ${errorMessage(error)}`,
      });
    }
  }

  private persistToolExecution(record: ToolExecutionRecord, activeTurn: ActiveTurn): void {
    // Durable storage is the write-ahead boundary: never acknowledge the Tool Result
    // to the session event stream if its forensic record could not be persisted.
    this.onToolExecution?.(record);
    this.inMemoryToolExecutions.push(record);
    activeTurn.toolExecutions.push(record);
  }

  private rememberCompactionResources(
    record: ToolExecutionRecord,
    resources: readonly ToolResourceAccess[],
  ): void {
    for (const resource of resources) {
      const evidence: CompactionResource = {
        key: boundedCompactionResourceKey(resource.key),
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
      return [...this.inMemoryTranscript];
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

  private captureCompactionEvidence(): CompactionEvidenceSnapshot {
    const transcript = this.listCompactionTranscriptEvidence();
    const toolExecutions = this.listCompactionToolEvidence();
    const resources = [...this.compactionResources.values()].slice(-256);
    const runningWork = [...this.currentCompactionRunningWork()];
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
    const checkpointSemanticState =
      this.compactionCheckpoint?.version === COMPACTION_CHECKPOINT_VERSION
        ? this.compactionCheckpoint.semanticState
        : undefined;
    const seededSemanticState = seedCompactionSemanticConstraints(
      checkpointSemanticState,
      this.compactionCheckpoint?.constraints ?? [],
    );
    const legacySnapshotRequired = this.compactionCheckpoint?.version === 1;
    const legacySnapshotMatches =
      this.legacyV1ActiveSnapshot !== undefined &&
      legacyV1ActiveSnapshotMatches(
        this.legacyV1ActiveSnapshot,
        this.compactionCheckpoint,
        this.messages,
      );
    const legacySnapshotMigration = !legacySnapshotRequired
      ? {
          state: seededSemanticState,
          requiredItemIds: [],
          transcriptFragments: [],
          complete: true,
        }
      : !legacySnapshotMatches || this.legacyV1ActiveSnapshot === undefined
        ? {
            state: seededSemanticState,
            requiredItemIds: [],
            transcriptFragments: [],
            complete: false,
          }
        : seedLegacyCompactionSnapshotUncertainties(seededSemanticState, {
            checkpointId: this.legacyV1ActiveSnapshot.checkpointId,
            fragments: this.legacyV1ActiveSnapshot.fragments,
          });
    const previousSemanticState = legacySnapshotMigration.state;
    const previousSemanticEvidenceWatermarks = initialCompactionSemanticEvidenceWatermarks(
      this.compactionCheckpoint,
    );
    const previousMessageWatermark = previousSemanticEvidenceWatermarks.messagesThroughSequence;
    const previousToolWatermark = previousSemanticEvidenceWatermarks.toolExecutionsThroughSequence;
    const newTranscript = transcript.filter((entry) => entry.sequence > previousMessageWatermark);
    const autoCoveredMessageSequences = new Set(
      newTranscript
        .filter(
          (entry) =>
            entry.provenance === TRANSCRIPT_MESSAGE_PROVENANCES[1] &&
            isDerivedCompactionReminderMessage(entry.message),
        )
        .map((entry) => entry.sequence),
    );
    const goalEntry =
      goal === undefined
        ? undefined
        : transcript.find((entry) => entry.sequence === goal.sourceSequence);
    const registry = buildCompactionSemanticEvidenceRegistry({
      messages: [
        ...newTranscript.filter((entry) => !autoCoveredMessageSequences.has(entry.sequence)),
        ...(goalEntry === undefined || newTranscript.includes(goalEntry) ? [] : [goalEntry]),
      ].map((entry) => ({
        sequence: entry.sequence,
        role: entry.message.role,
        summary: renderCompactionMessageEvidence(entry),
      })),
      toolExecutions: toolExecutions
        .filter((record) => record.sequence > previousToolWatermark)
        .map(compactionToolEvidence),
      resources: resources
        .slice()
        .reverse()
        .map((resource) => ({ key: resource.key, mode: resource.mode })),
      // `runningWork` is the authoritative, richer session source in the checkpoint.
      // Do not mirror it into semanticState and create a second continuation truth.
      runningSessions: [],
    });
    const modelContext = buildCompactionSemanticModelContext(
      registry,
      previousSemanticState,
      48_000,
    );
    return {
      transcript,
      toolExecutions,
      resources,
      runningWork,
      completeness,
      goal,
      newGoalSourceSequence,
      previousSemanticState,
      registry,
      modelContext: modelContext.prompt,
      presentedEvidenceIds: modelContext.includedEvidenceIds,
      expectedActiveMessages: [...this.messages],
      expectedLatestCheckpointId: this.compactionCheckpoint?.id,
      previousSemanticEvidenceWatermarks,
      autoCoveredMessageSequences,
      legacySnapshotMigrationComplete: legacySnapshotMigration.complete,
      legacySnapshotRequiredItemIds: legacySnapshotMigration.requiredItemIds,
      legacySnapshotTranscriptFragments: legacySnapshotMigration.transcriptFragments,
      legacySnapshotRemovableRawMessageCount:
        legacySnapshotMigration.complete && legacySnapshotMatches
          ? (this.legacyV1ActiveSnapshot?.removableRawMessageCount ?? 0)
          : 0,
      evidenceWatermarks: {
        transcriptMessagesThroughSequence: Math.max(
          this.compactionCheckpoint?.transcript.messages.throughSequence ?? -1,
          transcript.at(-1)?.sequence ?? -1,
        ),
        toolExecutionsThroughSequence: Math.max(
          this.compactionCheckpoint?.transcript.toolExecutions.throughSequence ?? -1,
          toolExecutions.at(-1)?.sequence ?? -1,
        ),
      },
    };
  }

  private buildCompactionDraft(
    evidence: CompactionEvidenceSnapshot,
    semanticDraft: CompactionModelDraft | undefined,
    includeSemanticSummary: boolean,
    summaryFailureReason: string | undefined,
  ): CompactionDraftSnapshot {
    const validated = validateCompactionModelDraft({
      draft: semanticDraft ?? EMPTY_COMPACTION_MODEL_DRAFT,
      evidenceRegistry: evidence.registry,
      presentedEvidenceIds: evidence.presentedEvidenceIds,
      ...(evidence.previousSemanticState !== undefined
        ? { previousState: evidence.previousSemanticState }
        : {}),
      ...(evidence.goal !== undefined
        ? {
            harnessGoal: {
              verbatimRequest: evidence.goal.verbatimRequest,
              sourceSequence: evidence.goal.sourceSequence,
            },
          }
        : {}),
    });
    let semanticState = mergeCompactionSemanticState(evidence.previousSemanticState, validated, {
      startsNewGoalScope: validated.startsNewGoalScope,
    });
    if (semanticDraft === undefined) {
      const fallbackConstraints = resolveActiveCompactionConstraints(
        evidence.transcript,
        this.compactionCheckpoint?.constraints ?? [],
      );
      const constraintsChanged =
        JSON.stringify(fallbackConstraints) !==
        JSON.stringify(this.compactionCheckpoint?.constraints ?? []);
      semanticState = replaceCompactionSemanticConstraints(semanticState, fallbackConstraints);
      const fallbackGoal =
        this.compactionCheckpoint?.goal === undefined
          ? evidence.goal
          : evidence.goal !== undefined &&
              evidence.newGoalSourceSequence !== undefined &&
              !constraintsChanged
            ? evidence.goal
            : this.compactionCheckpoint.goal;
      semanticState = replaceCompactionSemanticGoal(semanticState, fallbackGoal);
    }
    const constraints = semanticState.constraints.flatMap((constraint) => {
      const sourceSequence = constraint.provenance.find(
        (reference) => reference.kind === "message",
      )?.messageSequence;
      return sourceSequence === null || sourceSequence === undefined
        ? []
        : [{ quote: constraint.text, sourceSequence }];
    });
    const semanticGoalSequence = semanticState.goal?.provenance.find(
      (reference) => reference.kind === "message",
    )?.messageSequence;
    const semanticGoal =
      semanticGoalSequence === null || semanticGoalSequence === undefined
        ? undefined
        : findLatestRealUserGoal(
            evidence.transcript.filter((entry) => entry.sequence === semanticGoalSequence),
          );
    const checkpointGoal = semanticGoal ?? this.compactionCheckpoint?.goal ?? evidence.goal;
    const effectiveNewGoalSourceSequence =
      checkpointGoal !== undefined &&
      checkpointGoal.sourceSequence !== this.compactionCheckpoint?.goal?.sourceSequence
        ? checkpointGoal.sourceSequence
        : undefined;
    const semanticSummaryText = includeSemanticSummary
      ? renderCompactionSemanticSummary(semanticState)
      : undefined;
    const summary: CompactionSummary =
      semanticSummaryText !== undefined
        ? createCompactionSummary(semanticSummaryText)
        : summaryFailureReason !== undefined
          ? { status: "fallback", reason: summaryFailureReason }
          : { status: "skipped" };
    const reminderItemIds = new Set(
      createCheckpointSemanticReminderProjection(semanticState).items.map((item) => item.itemId),
    );
    const legacySnapshotReminderCoverageComplete =
      evidence.legacySnapshotRequiredItemIds.length === 0 ||
      evidence.legacySnapshotRequiredItemIds.every((itemId) => reminderItemIds.has(itemId));
    const toolState = buildCompactionToolState(
      evidence.transcript.map((entry) => entry.message),
      evidence.toolExecutions,
      32,
      evidence.completeness,
    );
    return {
      draft: {
        ...(checkpointGoal ? { goal: checkpointGoal } : {}),
        constraints: [...constraints],
        resources: [...evidence.resources],
        toolState,
        runningWork: [...evidence.runningWork],
        context: {
          cwd: this.capabilityManifest.dynamicContext.cwd,
          stableRuleIds: [...this.capabilityManifest.stableContext.rules],
          systemPromptSha256: createHash("sha256").update(this.systemPrompt).digest("hex"),
          skills: this.capabilityManifest.skills.map((skill) => ({
            name: skill.name,
            source: skill.source,
          })),
          explicitSkillNames: [
            ...this.latestExplicitSkillNames(evidence.transcript, effectiveNewGoalSourceSequence),
          ],
        },
        summary,
      },
      semanticState,
      semanticSummaryText,
      semanticRejectionCount: validated.rejections.length,
      legacySnapshotReminderCoverageComplete,
      coveredEvidenceIds: validated.coveredEvidenceIds,
      expectedActiveMessages: evidence.expectedActiveMessages,
      expectedLatestCheckpointId: evidence.expectedLatestCheckpointId,
      evidenceWatermarks: evidence.evidenceWatermarks,
      legacySnapshotTranscriptFragments: evidence.legacySnapshotTranscriptFragments,
    };
  }

  private async runCompactionTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    reason: ContextCompactionReason,
  ): Promise<void> {
    try {
      await this.runCompaction(queue, reason, activeTurn, true);
    } catch (error) {
      queue.push({ type: "error", stage: "plan", message: errorMessage(error) });
    } finally {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = undefined;
      }
      queue.close();
    }
  }

  private advanceCompactionSemanticEvidenceWatermarks(
    evidence: CompactionEvidenceSnapshot,
    coveredEvidenceIds: readonly string[],
  ): CompactionSemanticEvidenceWatermarks {
    const previous = evidence.previousSemanticEvidenceWatermarks;
    if (coveredEvidenceIds.length === 0) {
      return previous;
    }
    const eligibleEvidenceIds = new Set(
      coveredEvidenceIds.filter((evidenceId) => evidence.presentedEvidenceIds.includes(evidenceId)),
    );
    const messageEvidenceBySequence = new Map(
      evidence.registry.flatMap((entry) =>
        entry.provenance.kind === "message" && entry.provenance.messageSequence !== null
          ? [[entry.provenance.messageSequence, entry.evidenceId] as const]
          : [],
      ),
    );
    let messagesThroughSequence = previous.messagesThroughSequence;
    for (let sequence = previous.messagesThroughSequence + 1; ; sequence += 1) {
      if (evidence.autoCoveredMessageSequences.has(sequence)) {
        messagesThroughSequence = sequence;
        continue;
      }
      const evidenceId = messageEvidenceBySequence.get(sequence);
      if (evidenceId === undefined || !eligibleEvidenceIds.has(evidenceId)) {
        break;
      }
      messagesThroughSequence = sequence;
    }
    const toolEvidenceByExecutionId = new Map(
      evidence.registry.flatMap((entry) =>
        entry.provenance.kind === "tool_execution" && entry.provenance.toolExecutionId !== null
          ? [[entry.provenance.toolExecutionId, entry.evidenceId] as const]
          : [],
      ),
    );
    const toolExecutionsBySequence = new Map(
      evidence.toolExecutions.map((record) => [record.sequence, record] as const),
    );
    let toolExecutionsThroughSequence = previous.toolExecutionsThroughSequence;
    for (let sequence = previous.toolExecutionsThroughSequence + 1; ; sequence += 1) {
      const record = toolExecutionsBySequence.get(sequence);
      if (record === undefined) {
        break;
      }
      const evidenceId = toolEvidenceByExecutionId.get(record.id);
      if (evidenceId === undefined || !eligibleEvidenceIds.has(evidenceId)) {
        break;
      }
      toolExecutionsThroughSequence = sequence;
    }
    return { messagesThroughSequence, toolExecutionsThroughSequence };
  }

  private countContiguousPresentedMessageEvidence(evidence: CompactionEvidenceSnapshot): number {
    if (!evidence.legacySnapshotMigrationComplete) {
      return 0;
    }
    const presentedEvidenceIds = new Set(evidence.presentedEvidenceIds);
    const evidenceIdBySequence = new Map(
      evidence.registry.flatMap((entry) =>
        entry.provenance.kind === "message" && entry.provenance.messageSequence !== null
          ? [[entry.provenance.messageSequence, entry.evidenceId] as const]
          : [],
      ),
    );
    let count = evidence.legacySnapshotRemovableRawMessageCount;
    for (
      let sequence = evidence.previousSemanticEvidenceWatermarks.messagesThroughSequence + 1;
      ;
      sequence += 1
    ) {
      if (evidence.autoCoveredMessageSequences.has(sequence)) {
        continue;
      }
      const evidenceId = evidenceIdBySequence.get(sequence);
      if (evidenceId === undefined || !presentedEvidenceIds.has(evidenceId)) {
        break;
      }
      count += 1;
    }
    return count;
  }

  private async runCompaction(
    queue: AsyncEventQueue<SessionEvent>,
    reason: ContextCompactionReason,
    activeTurn?: ActiveTurn,
    emitCancellationOnAbort = false,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const settings = this.compaction;
    const defaultStrategy = settings?.strategy ?? "summarize";
    this.debug(queue, "compaction", "start", startedAt, {
      reason,
      messages: this.messages.length,
      timeoutMs: settings?.timeoutMs ?? 120_000,
      maxOutputTokens: settings?.maxOutputTokens ?? 8_192,
    });
    queue.push({ type: "compaction-start", reason });
    if (this.isTurnAborted(activeTurn)) {
      if (emitCancellationOnAbort && activeTurn !== undefined) {
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
    let summaryFailureReason: string | undefined;
    const abortSignal = activeTurn?.abortController.signal;
    const evidenceStartedAt = Date.now();
    const evidence = this.captureCompactionEvidence();
    this.debug(queue, "compaction", "evidence ready", evidenceStartedAt, {
      transcriptMessages: evidence.transcript.length,
      toolExecutions: evidence.toolExecutions.length,
    });
    if (this.compactionCheckpoint?.version === 1 && this.commitPersistedCompaction === undefined) {
      this.debug(queue, "compaction", "legacy V1 snapshot requires durable transcript", startedAt);
      queue.push({
        type: "context-compacted",
        reason,
        strategy,
        removed: 0,
        kept: this.messages.length,
      });
      return false;
    }
    if (!evidence.legacySnapshotMigrationComplete) {
      this.debug(queue, "compaction", "legacy V1 snapshot migration incomplete", startedAt);
      queue.push({
        type: "context-compacted",
        reason,
        strategy,
        removed: 0,
        kept: this.messages.length,
      });
      return false;
    }
    const maxRemovedTranscriptMessages = this.countContiguousPresentedMessageEvidence(evidence);
    let result: Awaited<ReturnType<typeof compactMessages>>;
    try {
      const draftStartedAt = Date.now();
      try {
        result = await compactMessages({
          messages: this.messages,
          strategy,
          keepRecentTurns: settings.keepRecentTurns,
          keepRecentTokens: settings.keepRecentTokens,
          model: this.model,
          semanticEvidencePrompt: evidence.modelContext,
          maxRemovedTranscriptMessages,
          ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
          ...(settings.maxOutputTokens !== undefined
            ? { maxOutputTokens: settings.maxOutputTokens }
            : {}),
          ...(this.structuredOutputReasoning
            ? { structuredOutputReasoning: this.structuredOutputReasoning }
            : {}),
          ...(this.structuredOutputProviderOptions
            ? { structuredOutputProviderOptions: this.structuredOutputProviderOptions }
            : {}),
          ...(abortSignal ? { abortSignal } : {}),
        });
      } finally {
        this.debug(queue, "compaction", "draft generation finished", draftStartedAt, {
          strategy,
        });
      }
      if (strategy === "summarize" && result.removed > 0 && result.semanticDraft === undefined) {
        throw new CompactionDraftFallbackError(
          COMPACTION_DRAFT_FALLBACK_REASONS.missingObject,
          "structured compaction draft is missing",
        );
      }
    } catch (error) {
      if (this.isTurnAborted(activeTurn)) {
        if (emitCancellationOnAbort && activeTurn !== undefined) {
          this.emitCancellation(queue, activeTurn);
        }
        return false;
      }
      if (strategy !== "summarize" || !CompactionDraftFallbackError.isInstance(error)) {
        throw error;
      }
      this.debug(queue, "compaction", "summarize failed, fallback to truncate", startedAt, {
        message: errorMessage(error),
      });
      summaryFailureReason = "structured checkpoint generation failed";
      strategy = "truncate";
      const fallbackStartedAt = Date.now();
      result = await compactMessages({
        messages: this.messages,
        strategy,
        keepRecentTurns: settings.keepRecentTurns,
        keepRecentTokens: settings.keepRecentTokens,
        model: this.model,
        maxRemovedTranscriptMessages,
        ...(abortSignal ? { abortSignal } : {}),
      });
      this.debug(queue, "compaction", "truncate fallback finished", fallbackStartedAt);
    }

    if (this.isTurnAborted(activeTurn)) {
      if (emitCancellationOnAbort && activeTurn !== undefined) {
        this.emitCancellation(queue, activeTurn);
      }
      return false;
    }

    const attemptedReduction = result.removed > 0 || result.truncatedTools > 0;
    const validationStartedAt = Date.now();
    const snapshot = attemptedReduction
      ? this.buildCompactionDraft(
          evidence,
          result.semanticDraft,
          strategy === "summarize" && result.removed > 0,
          summaryFailureReason,
        )
      : undefined;
    this.debug(queue, "compaction", "checkpoint validation finished", validationStartedAt, {
      semanticRejections: snapshot?.semanticRejectionCount ?? 0,
    });
    if (snapshot !== undefined && snapshot.semanticRejectionCount > 0) {
      this.debug(queue, "compaction", "rejected ungrounded semantic claims", startedAt, {
        count: snapshot.semanticRejectionCount,
      });
    }
    if (snapshot !== undefined && !snapshot.legacySnapshotReminderCoverageComplete) {
      this.debug(queue, "compaction", "legacy V1 snapshot exceeds reminder projection", startedAt);
      queue.push({
        type: "context-compacted",
        reason,
        strategy,
        removed: 0,
        kept: this.messages.length,
      });
      return false;
    }
    // Structured checkpoint state is injected through the per-turn checkpoint reminder.
    // Do not also persist a derived SUMMARY/ACK pair in active history: that duplicates
    // the same state and lets repeated compaction manufacture progress without new evidence.
    const activeProjection = repairActiveToolProtocol(result.messages);
    const candidateActiveMessages = [...activeProjection.messages];
    if (activeProjection.status === ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS.repaired) {
      this.debug(queue, "compaction", "repaired malformed active Tool protocol", startedAt, {
        removedToolCallIds: activeProjection.removedToolCallIds.join(","),
        removedToolResultIds: activeProjection.removedToolResultIds.join(","),
      });
    }
    if (
      this.compactionCheckpoint?.version === 1 &&
      candidateActiveMessages.some(isDerivedCompactionReminderMessage)
    ) {
      this.debug(queue, "compaction", "legacy V1 snapshot remains in active history", startedAt);
      queue.push({
        type: "context-compacted",
        reason,
        strategy,
        removed: 0,
        kept: this.messages.length,
      });
      return false;
    }
    const activeContextBytes = (messages: readonly ModelMessage[]): number =>
      Buffer.byteLength(JSON.stringify(messages), "utf8");
    const progressed =
      attemptedReduction &&
      activeContextBytes(candidateActiveMessages) < activeContextBytes(this.messages);
    const activeMessages = progressed ? candidateActiveMessages : [...this.messages];
    const semanticEvidenceWatermarks = progressed
      ? this.advanceCompactionSemanticEvidenceWatermarks(
          evidence,
          snapshot?.coveredEvidenceIds ?? [],
        )
      : evidence.previousSemanticEvidenceWatermarks;
    let checkpoint: CompactionCheckpoint | undefined;
    if (progressed) {
      const commitStartedAt = Date.now();
      if (this.commitPersistedCompaction !== undefined) {
        if (snapshot === undefined) {
          throw new Error("compaction checkpoint snapshot is missing");
        }
        checkpoint = this.commitPersistedCompaction({
          messages: activeMessages,
          expectedActiveMessages: snapshot.expectedActiveMessages,
          expectedLatestCheckpointId: snapshot.expectedLatestCheckpointId,
          draft: snapshot.draft,
          semanticState: snapshot.semanticState,
          semanticEvidenceWatermarks,
          evidenceWatermarks: snapshot.evidenceWatermarks,
          ...(snapshot.legacySnapshotTranscriptFragments.length > 0
            ? {
                legacySnapshotTranscriptFragments: snapshot.legacySnapshotTranscriptFragments,
              }
            : {}),
        });
      } else {
        if (snapshot === undefined) {
          throw new Error("compaction checkpoint snapshot is missing");
        }
        const previousCheckpoint = this.compactionCheckpoint;
        checkpoint = createCompactionCheckpoint({
          draft: snapshot.draft,
          semanticState: snapshot.semanticState,
          semanticEvidence: semanticEvidenceWatermarks,
          generation: (previousCheckpoint?.generation ?? 0) + 1,
          transcript: {
            messages: {
              fromSequenceExclusive: previousCheckpoint?.transcript.messages.throughSequence ?? -1,
              throughSequence: snapshot.evidenceWatermarks.transcriptMessagesThroughSequence,
            },
            toolExecutions: {
              fromSequenceExclusive:
                previousCheckpoint?.transcript.toolExecutions.throughSequence ?? -1,
              throughSequence: snapshot.evidenceWatermarks.toolExecutionsThroughSequence,
            },
            completeness: evidence.completeness,
          },
          ...(previousCheckpoint !== undefined
            ? { previousCheckpointId: previousCheckpoint.id }
            : {}),
        });
        this.onReplace?.(activeMessages);
      }
      this.debug(queue, "compaction", "checkpoint commit finished", commitStartedAt, {
        durable: this.commitPersistedCompaction !== undefined,
      });
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
      removed: progressed ? result.removed : 0,
      kept: activeMessages.length,
      ...(progressed && result.truncatedTools > 0 ? { truncatedTools: result.truncatedTools } : {}),
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
      removed: progressed ? result.removed : 0,
      kept: activeMessages.length,
      truncatedTools: progressed ? result.truncatedTools : 0,
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
      this.toolCoordinator.hasExecutionStarted(pending.toolCallId),
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
      return reason === SESSION_CANCELLATION_REASONS.timeout
        ? `本轮等待时间过长，已自动停止，但刚才的对话和进度未能保存。${resultCheck}`
        : reason === SESSION_CANCELLATION_REASONS.runtime
          ? `本轮因运行异常而中断，刚才的对话和进度未能保存。${resultCheck}`
          : `已停止本轮，但刚才的对话和进度未能保存。${resultCheck}`;
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
        if (this.capabilityManifest.lifecycle.hostMode === CAPABILITY_HOST_MODES.oneShot) {
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
    const recoveryPolicy =
      "这份恢复记录只描述上一轮的权威历史事实，不授权继续或重试旧任务。下一轮必须以最新真实用户消息的目标和约束为准；如果用户换题、放弃旧任务或禁止工具，不得为了恢复旧任务检查或调用工具。executionState=not_executed 表示工具确定未执行，无需检查；executionState=outcome_unknown 只允许在最新用户明确要求继续或核对上一任务时先检查，检查不等于重试。";
    switch (reason) {
      case SESSION_CANCELLATION_REASONS.user:
        return `用户主动停止了本轮。${taskNumbers}这些任务已收到停止请求；已完成的步骤和工具记录仍然有效，不要自动重复 outcome=success 的操作。${recoveryPolicy}`;
      case SESSION_CANCELLATION_REASONS.timeout: {
        const duration =
          this.turnTimeoutMs !== undefined ? `（${String(this.turnTimeoutMs)}ms）` : "";
        if (execSessionIds.length === 0) {
          return `本轮因超时${duration}停止。已完成的步骤和工具记录仍然有效。${recoveryPolicy}`;
        }
        if (this.capabilityManifest.lifecycle.hostMode === CAPABILITY_HOST_MODES.oneShot) {
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

  private persistCancelledTurn(
    queue: AsyncEventQueue<SessionEvent>,
    activeTurn: ActiveTurn,
    turnStart: number,
    completedResponseMessages: readonly ModelMessage[],
    turnStartedAt: number,
  ): void {
    this.captureCancellationActivity(activeTurn);
    try {
      this.persistPendingToolCancellations(activeTurn);
    } catch (error) {
      this.messages.splice(turnStart);
      activeTurn.cancellationPersistenceAttempted = true;
      queue.push({
        type: "error",
        stage: "execute",
        message: `取消工具账本持久化失败: ${errorMessage(error)}`,
      });
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
      this.messages.splice(turnStart + 1);
      const rememberedResponseMessages = completedStepMessages(activeTurn);
      const completedMessages = repairActiveToolProtocol(
        stripReasoningMessages(
          rememberedResponseMessages.length > 0
            ? rememberedResponseMessages
            : completedResponseMessages,
        ),
      ).messages;
      activeTurn.cancellationPersisted = true;
      this.messages.push(...completedMessages);
      this.messages.push(
        createCancelledTurnRecoveryMessage({
          context: this.cancellationContextMessage(activeTurn),
          completedMessages,
          toolExecutions: activeTurn.toolExecutions,
        }),
      );
      this.messages.push(
        createTurnCancellationMessage(
          this.cancellationDisplayMessage(activeTurn),
          activeTurn.cancellationReason ?? SESSION_CANCELLATION_REASONS.runtime,
        ),
      );
      this.debug(queue, "persist", "persisting cancelled turn", turnStartedAt, {
        appendedMessages: this.messages.length - turnStart,
      });
      try {
        this.persistMessages(this.messages.slice(turnStart));
        activeTurn.cancellationPersisted = true;
      } catch (error) {
        activeTurn.cancellationPersisted = false;
        this.messages.splice(turnStart);
        queue.push({
          type: "error",
          stage: "execute",
          message: `取消状态持久化失败: ${errorMessage(error)}`,
        });
      }
    }
    this.emitCancellation(queue, activeTurn);
  }

  private persistPendingToolCancellations(activeTurn: ActiveTurn): void {
    const cancellationReason =
      activeTurn.cancellationReason ?? SESSION_CANCELLATION_REASONS.runtime;
    for (const pending of activeTurn.pendingToolCalls.values()) {
      const executionState = this.toolCoordinator.hasExecutionStarted(pending.toolCallId)
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
      this.persistToolExecution(
        createToolExecutionRecord({
          toolCallId: pending.toolCallId,
          agentName: pending.agentName,
          toolName: pending.toolName,
          input: pending.input,
          result,
        }),
        activeTurn,
      );
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
