export { ConversationEngine } from "./engine/conversation-engine.ts";
export type { EngineModelSwitch } from "./engine/conversation-engine.ts";
export type {
  AgentBootstrapIssue,
  ConversationEngineOptions,
  CreateSessionInput,
  ForkSessionInput,
} from "./engine/conversation-engine.ts";
export { AgentSession } from "./engine/agent-session.ts";
export type {
  SessionModelSwitch,
  SessionToolExclusion,
  ToolSchemaPolicy,
} from "./engine/agent-session.ts";
export type {
  AgentSessionOptions,
  SessionCompactionSettings,
  SessionSkillSummary,
} from "./engine/agent-session.ts";
export type { SessionAttachment, SessionSendInput } from "./engine/session-attachments.ts";
export {
  WORKSPACE_INSTRUCTION_FILE_NAMES,
  WORKSPACE_INSTRUCTIONS_MAX_CHARS,
  WORKSPACE_INSTRUCTIONS_MODES,
  createWorkspaceInstructionsSource,
  findWorkspaceInstructionsPath,
  parseWorkspaceInstructionsSetting,
} from "./engine/workspace-instructions.ts";
export type {
  WorkspaceInstructions,
  WorkspaceInstructionsSetting,
  WorkspaceInstructionsSource,
} from "./engine/workspace-instructions.ts";
export {
  resolveContextWindow,
  lookupContextWindow,
  resolveModelContextWindow,
  CONTEXT_WINDOW_SOURCES,
} from "./engine/context-window.ts";
export type {
  ContextWindowResolution,
  ContextWindowSource,
  ResolveModelContextWindowInput,
} from "./engine/context-window.ts";
export { createDefaultModelCatalog } from "./engine/model-catalog-default.ts";
export {
  ModelCatalog,
  defaultModelCatalogCachePath,
  lookupCatalogContextWindow,
  trimModelCatalog,
  MODEL_CATALOG_REFRESH_RESULTS,
} from "./engine/model-catalog.ts";
export type {
  ModelCatalogData,
  ModelCatalogLimit,
  ModelCatalogOptions,
  ModelCatalogRefreshResult,
} from "./engine/model-catalog.ts";
export {
  compactMessages,
  findTurnBoundaries,
  SUMMARY_PREFIX,
  SUMMARY_ACK,
} from "./engine/compactor.ts";
export type { CompactionInput, CompactionResult } from "./engine/compactor.ts";
export { ROLL_RESOURCE_HINTS_META_KEY, buildAgentToolset } from "./tool-bridge/build-tools.ts";
export type {
  AgentToolSource,
  SourceTool,
  ApprovalRequest,
  ToolBridgeContext,
  BuiltToolset,
} from "./tool-bridge/build-tools.ts";
export type { SessionBashSettings } from "./tool-bridge/bash-tool.ts";
export {
  type CommandClassifier,
  type CommandClassification,
  COMMAND_CLASSIFICATIONS,
  unknownCommandClassifier,
} from "./types/command-classification.ts";
export { ruleBasedClassifier } from "./bash/classifier/index.ts";
export {
  buildPowerShellEncodedCommand,
  resolveShellProfile,
  SHELL_PROFILE_IDS,
  SHELL_TOOL_NAMES,
} from "./bash/profile.ts";
export type {
  ShellProfile,
  ShellProfileId,
  ShellKillOptions,
  ShellProfileResolutionDeps,
  ShellProfileResolutionResult,
  ShellSpawnSpec,
  ShellToolName,
} from "./bash/profile.ts";
export {
  buildSessionExecToolset,
  EXEC_COMMAND_ID,
  EXEC_LIST_ID,
  EXEC_POLL_ID,
  type SessionExecSettings,
} from "./tool-bridge/session-exec-tool.ts";
export { ToolRegistry } from "./tool-bridge/naming.ts";
export type { ToolRoute } from "./tool-bridge/naming.ts";
export {
  TOOL_RESOURCE_ACCESS_MODES,
  TOOL_RESOURCE_HINT_KINDS,
} from "./tool-bridge/tool-execution-coordinator.ts";
export type {
  ToolResourceAccess,
  ToolResourceAccessMode,
  ToolResourceHint,
  ToolResourceHintKind,
} from "./tool-bridge/tool-execution-coordinator.ts";
export {
  TOOL_CANCELLATION_EXECUTION_STATES,
  TOOL_OUTCOME_KINDS,
  normalizeToolResult,
  readToolOutcome,
} from "./tool-bridge/normalize-result.ts";
export type {
  NormalizedToolResult,
  ToolCancellationExecutionState,
  ToolModelOutput,
  ToolOutcome,
  ToolOutcomeKind,
} from "./tool-bridge/normalize-result.ts";
export { ThreadStore, defaultThreadsDir, expandTilde } from "./store/thread-store.ts";
export type { ThreadStoreOptions } from "./store/thread-store.ts";
export type {
  ThreadRecord,
  CreateThreadInput,
  ListThreadsOptions,
  ThreadSnapshot,
  ForkThreadSnapshotInput,
} from "./store/thread-store.ts";
export {
  THREAD_ORIGIN_KINDS,
  threadOriginSchema,
  scheduledThreadOriginSchema,
  threadDerivedFromSchema,
} from "./store/thread-origin.ts";
export type {
  ThreadOrigin,
  ScheduledThreadOrigin,
  ThreadDerivedFrom,
} from "./store/thread-origin.ts";
export {
  SCHEDULE_LEDGER_READ_STATUSES,
  ScheduleStore,
  readScheduleLedger,
} from "./scheduler/schedule-store.ts";
export type {
  ScheduleStoreOptions,
  ClaimDueInput,
  ScheduleLedgerReadResult,
  ScheduleLedgerReadStatus,
} from "./scheduler/schedule-store.ts";
export { SCHEDULER_LIMITS } from "./scheduler/limits.ts";
export {
  TRIGGER_KINDS,
  ScheduleTriggerError,
  computeNextRunAtMs,
  createIntervalTrigger,
  describeTrigger,
  formatDuration,
  formatInterval,
  parseIntervalText,
  parseMaxRunText,
  parseTriggerJson,
  triggerSpecSchema,
} from "./scheduler/trigger.ts";
export type { TriggerKind, TriggerSpec } from "./scheduler/trigger.ts";
export {
  CANCEL_INVOCATION_OUTCOMES,
  COMPLETE_INVOCATION_OUTCOMES,
  EXECUTOR_LIVENESS,
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_LIVE_STATUSES,
  INVOCATION_MODES,
  INVOCATION_STATUSES,
  INVOCATION_TERMINAL_STATUSES,
  INVOCATION_TREE_LIVENESS,
  TRACKED_LEADER_STATES,
  SCHEDULE_STATUSES,
  SCHEDULE_STORE_ERROR_CODES,
  ScheduleStoreError,
} from "./scheduler/types.ts";
export type {
  CancelInvocationOptions,
  CancelInvocationOutcome,
  ClaimedInvocation,
  CompleteInvocationInput,
  CompleteInvocationOutcome,
  CompleteInvocationStatus,
  CreateScheduleInput,
  EnqueueManualInvocationOptions,
  ExecutorIdentity,
  ExecutorLiveness,
  ExecutorLivenessProbe,
  FailInvocationOptions,
  InvocationFailureOutcome,
  InvocationMode,
  InvocationRecord,
  InvocationStatus,
  InvocationTreeLiveness,
  InvocationTreeLivenessProbe,
  FinalizeCancellationInput,
  PersistedTrackedGroup,
  RecordInvocationTreeInput,
  RemoveScheduleOptions,
  ScheduleRecord,
  ScheduleStatus,
  ScheduleStoreErrorCode,
  TrackedLeaderState,
} from "./scheduler/types.ts";
export { DefaultToolPolicy } from "./policy/default-policy.ts";
export { ConfigurableToolPolicy } from "./policy/configurable-policy.ts";
export {
  UNATTENDED_CONFIRMATION_DENIED_REASON,
  UnattendedToolPolicy,
} from "./policy/unattended-policy.ts";
export type { UnattendedDeniedConfirmation } from "./policy/unattended-policy.ts";
export {
  CAPABILITY_HOST_MODES,
  CAPABILITY_TURN_ORIGIN_KINDS,
} from "./engine/capability-manifest.ts";
export type {
  CapabilityHostMode,
  CapabilityTurnOrigin,
  CapabilityExternalDynamicContext,
} from "./engine/capability-manifest.ts";
export type {
  ConfigurableToolPolicyOptions,
  ToolApprovalDefault,
  ToolApprovalOverrideAction,
} from "./policy/configurable-policy.ts";
export type {
  ToolPolicy,
  ToolPolicyContext,
  PolicyDecision,
  PolicyAction,
  ToolAnnotations,
} from "./types/policy.ts";
export { ApprovalGate } from "./approval/approval-gate.ts";
export type { ApprovalDecision } from "./approval/approval-gate.ts";
export { RuntimeServer } from "./server/runtime-server.ts";
export {
  RuntimeClientRequestCancelledError,
  RuntimeClientRequestCoordinator,
  RuntimeClientRequestError,
  RuntimeClientRequestExpiredError,
  createRuntimeClientResponderId,
} from "./server/runtime-client-request-coordinator.ts";
export type {
  RuntimeClientRequest,
  RuntimeClientRequestCoordinatorOptions,
  RuntimeClientRequestOptions,
  RuntimeClientResponder,
  RuntimeClientResponderId,
} from "./server/runtime-client-request-coordinator.ts";
export { RuntimeService, RuntimeServiceError } from "./service/runtime-service.ts";
export { AttachmentStore } from "./service/attachment-store.ts";
export type { AttachmentStoreOptions, AttachmentStoreFailure } from "./service/attachment-store.ts";
export type {
  RuntimeServiceEngine,
  RuntimeServiceOptions,
  RuntimeServiceSession,
} from "./service/runtime-service.ts";
export { createStdioConnection } from "./server/transport/stdio.ts";
export { RpcMethod, EVENT_NOTIFICATION, isRequest } from "./server/protocol.ts";
export type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcId,
} from "./server/protocol.ts";
export type {
  SessionEvent,
  SessionEventStage,
  SessionTokenUsage,
  ContextCompactionReason,
  ContextCompactionStrategy,
} from "./types/events.ts";
export {
  createTurnCancellationMessage,
  readTurnCancellationReason,
  SESSION_CANCELLATION_REASONS,
  USER_CANCELLATION_ABORT_REASON,
} from "./types/cancellation.ts";
export type { SessionCancellationReason } from "./types/cancellation.ts";
export {
  APPROVAL_DIFF_PREVIEW_KEY,
  fileChangeDiffSchema,
  fileChangeDisplaySchema,
  getApprovalDiffPreview,
  getFileChangeDisplay,
} from "@roll-agent/protocol";
export type { FileChangeDiff, FileChangeDisplay, FileChangeKind } from "@roll-agent/protocol";

export { readScheduleHistory, readScheduleRun } from "./scheduler/schedule-store.ts";
export type {
  ReadScheduleHistoryOptions,
  ScheduleHistoryReadResult,
  ScheduleRunReadResult,
} from "./scheduler/schedule-store.ts";
export type {
  BackfillThreadReferenceInput,
  RegisterThreadReferenceInput,
  ScheduleThreadReference,
  ScheduleRunHistoryEntry,
  ScheduleHistoryTask,
} from "./scheduler/types.ts";
