import { createHash, randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import {
  APPROVAL_DIFF_PREVIEW_KEY,
  APPROVAL_EXPLANATION_PREVIEW_KEY,
  RUNTIME_ERROR_CODES,
  RUNTIME_FEATURES_V13,
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_V14_MAX_ATTACHMENT_BYTES,
  RUNTIME_V14_MAX_ATTACHMENT_CHUNK_BYTES,
  RUNTIME_V14_MAX_STAGED_ATTACHMENTS,
  RUNTIME_V14_MAX_TURN_ATTACHMENTS,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  approvalExplanationSchema,
  approvalIdSchema,
  normalizeUserInputResultForForm,
  operationIdSchema,
  parseLatestRuntimeMethodResult,
  runtimeDurableEventV13Schema,
  runtimeEphemeralEventV13Schema,
  runtimeInstanceIdSchema,
  runtimeProtocolVersionSchema,
  streamIdSchema,
  threadIdSchema,
  userInputFormSchema,
  type ActiveTurn,
  type ApprovalResolution,
  type InitializeParams,
  type InitializeResult,
  type JsonValue,
  type OperationView,
  type PendingApproval,
  type RuntimeEvent,
  type RuntimeEventEnvelopeV14,
  type RuntimeEventsResumeParams,
  type RuntimeEventsResumeResult,
  type RuntimeInstanceId,
  type LatestRuntimeMethodParams,
  type LatestRuntimeMethodResult,
  type RuntimeMethodParams,
  type RuntimeMethodResult,
  type RuntimeProtocolVersion,
  type RuntimeProtocolErrorDataV14,
  type ThreadSnapshotV14Full,
  type ThreadId,
  type ThreadSummary,
  type TurnId,
  type UiMessageV14,
  type UserInputForm,
  type UserInputResult,
} from "@roll-agent/protocol";
import type { AgentSession } from "../engine/agent-session.ts";
import type { SessionAttachment } from "../engine/session-attachments.ts";
import { AttachmentStore, type AttachmentStoreFailure } from "./attachment-store.ts";
import type { SessionUserInputRequestId } from "../interaction/user-input-interaction-manager.ts";
import { createSafeCapabilitySnapshot } from "../engine/capability-manifest.ts";
import type { SessionEvent } from "../types/events.ts";
import {
  isSensitiveFieldName,
  redactSecretText,
  toRedactedToolExecutionRecordSummary,
} from "../tool-bridge/tool-execution-record.ts";
import type { ToolOutcome } from "../tool-bridge/normalize-result.ts";
import {
  RuntimeEventCursorExpiredError,
  RuntimeEventCursorGapError,
  ThreadStore,
  type StoredRuntimeEvent,
  type SequencedToolExecutionRecord,
  type ThreadRecord,
} from "../store/thread-store.ts";

const DEFAULT_MAX_FRAME_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_MAX_PAGE_SIZE = 500;
const DEFAULT_IDEMPOTENCY_CACHE_ENTRIES = 10_000;
const MAX_SAFE_STRING_CHARS = 16_000;
const MAX_SAFE_ARRAY_ITEMS = 64;
const MAX_SAFE_OBJECT_KEYS = 128;
const MAX_SAFE_DEPTH = 16;
const REDACTED_KEYS = new Set([
  "_meta",
  "authorization",
  "cookie",
  "password",
  "provideroptions",
  "raw",
  "secret",
  "token",
]);

type RollErrorCode = RuntimeProtocolErrorDataV14["rollCode"];

export type RuntimeServiceSession = Pick<
  AgentSession,
  | "id"
  | "send"
  | "approve"
  | "reject"
  | "cancel"
  | "close"
  | "getCapabilityManifest"
  | "getCapabilityTurnContext"
> &
  Partial<Pick<AgentSession, "setUserInputAvailable" | "resolveUserInput" | "cancelUserInput">>;

export interface RuntimeServiceEngine {
  createSession(input?: { readonly title?: string }): Promise<RuntimeServiceSession>;
  resumeSession(threadId: string): Promise<RuntimeServiceSession>;
}

export interface RuntimeServiceOptions {
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly runtimeVersion?: string;
  readonly maxFrameBytes?: number;
  readonly idempotencyCacheEntries?: number;
  /**
   * Optional host-controlled projection. Raw model reasoning is never sent to public clients.
   * Supplying this enables the `reasoning-summary` capability.
   */
  readonly reasoningSummaryProjector?: (delta: string) => string | undefined;
  /** Supplying this enables the Protocol 1.4 `attachments` capability. */
  readonly attachmentStore?: AttachmentStore;
}

export interface RuntimeApprovalIdentity {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly approvalId: ReturnType<typeof approvalIdSchema.parse>;
}

export type RuntimeApprovalDecision =
  | { readonly decision: "approve"; readonly scope?: "once" | "session" }
  | { readonly decision: "reject"; readonly reason?: string };

interface ActiveTurnState {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly session: RuntimeServiceSession;
  readonly startedAt: string;
  status: ActiveTurn["status"];
  interactionFailure: string | undefined;
}

interface TurnProjectionState {
  streamId: ReturnType<typeof streamIdSchema.parse> | undefined;
  text: string;
  terminalEvent:
    | Extract<
        RuntimeEvent,
        {
          readonly type: "turn.completed" | "turn.cancelled" | "turn.failed";
        }
      >
    | undefined;
}

interface PendingApprovalState {
  readonly threadId: ThreadId;
  readonly session: RuntimeServiceSession;
  readonly approval: PendingApproval;
  readonly expiresAt: string | undefined;
}

interface PendingUserInputState {
  readonly requestId: SessionUserInputRequestId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly session: RuntimeServiceSession;
  readonly form: UserInputForm;
  readonly expiresAt: string;
}

export type RuntimeThreadSnapshot = Omit<ThreadSnapshotV14Full, "pendingInteractions">;

export interface RuntimeEventReplayBatch extends RuntimeEventsResumeResult {
  readonly events: readonly StoredRuntimeEvent[];
}

export type RuntimeUserInputInteractionEvent =
  | {
      readonly type: "required";
      readonly requestId: SessionUserInputRequestId;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly form: UserInputForm;
      readonly expiresAt: string;
    }
  | {
      readonly type: "settled";
      readonly requestId: SessionUserInputRequestId;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly reason: string;
    };

export class RuntimeServiceError extends Error {
  readonly rollCode: RollErrorCode;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    rollCode: RollErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly details?: unknown } = {},
  ) {
    super(message);
    this.name = "RuntimeServiceError";
    this.rollCode = rollCode;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

type MutationRuntimeMethod =
  | typeof RUNTIME_METHODS.threadCreate
  | typeof RUNTIME_METHODS.threadRename
  | typeof RUNTIME_METHODS.threadDelete
  | typeof RUNTIME_METHODS.threadDetach
  | typeof RUNTIME_METHODS.turnStart
  | typeof RUNTIME_METHODS.turnCancel
  | typeof RUNTIME_METHODS.approvalRespond
  | typeof RUNTIME_METHODS.attachmentStage
  | typeof RUNTIME_METHODS.attachmentChunk
  | typeof RUNTIME_METHODS.attachmentCommit
  | typeof RUNTIME_METHODS.attachmentRelease;

interface MutationRequestEntry {
  readonly method: MutationRuntimeMethod;
  readonly fingerprint: string;
  readonly response: Promise<unknown>;
}

function mutationRequestFingerprint(params: unknown): string {
  const serialized = JSON.stringify(params);
  if (serialized === undefined) {
    throw new RuntimeServiceError(
      RUNTIME_ERROR_CODES.invalidParams,
      "无法为 mutation 请求生成稳定指纹",
    );
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export class MutationRequestCache {
  private readonly maxEntries: number;
  private readonly inFlight = new Map<string, MutationRequestEntry>();
  private readonly settled = new Map<string, MutationRequestEntry>();

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("idempotencyCacheEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
  }

  run<TMethod extends MutationRuntimeMethod>(
    requestId: string,
    method: TMethod,
    params: LatestRuntimeMethodParams<TMethod>,
    action: () => LatestRuntimeMethodResult<TMethod> | Promise<LatestRuntimeMethodResult<TMethod>>,
  ): Promise<LatestRuntimeMethodResult<TMethod>> {
    const fingerprint = mutationRequestFingerprint(params);
    const inFlight = this.inFlight.get(requestId);
    if (inFlight !== undefined) {
      this.assertMatchingRequest(requestId, method, fingerprint, inFlight);
      return inFlight.response.then((result) => parseLatestRuntimeMethodResult(method, result));
    }
    const settled = this.settled.get(requestId);
    if (settled !== undefined) {
      this.assertMatchingRequest(requestId, method, fingerprint, settled);
      this.settled.delete(requestId);
      this.settled.set(requestId, settled);
      return settled.response.then((result) => parseLatestRuntimeMethodResult(method, result));
    }
    const pending = Promise.resolve().then(action);
    const entry: MutationRequestEntry = {
      method,
      fingerprint,
      response: pending,
    };
    this.inFlight.set(requestId, entry);
    pending.then(
      () => {
        this.settle(requestId, entry);
      },
      () => {
        this.settle(requestId, entry);
      },
    );
    return pending;
  }

  clear(): void {
    this.inFlight.clear();
    this.settled.clear();
  }

  private assertMatchingRequest(
    requestId: string,
    method: MutationRuntimeMethod,
    fingerprint: string,
    entry: MutationRequestEntry,
  ): void {
    if (entry.method === method && entry.fingerprint === fingerprint) {
      return;
    }
    throw new RuntimeServiceError(
      RUNTIME_ERROR_CODES.invalidParams,
      `requestId "${requestId}" 已用于不同请求`,
    );
  }

  private settle(requestId: string, entry: MutationRequestEntry): void {
    if (this.inFlight.get(requestId) !== entry) {
      return;
    }
    this.inFlight.delete(requestId);
    this.settled.set(requestId, entry);
    while (this.settled.size > this.maxEntries) {
      const oldestRequestId = this.settled.keys().next().value;
      if (oldestRequestId === undefined) {
        return;
      }
      this.settled.delete(oldestRequestId);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown, key: string | undefined, depth = 0): JsonValue {
  if (key !== undefined && (REDACTED_KEYS.has(key.toLowerCase()) || isSensitiveFieldName(key))) {
    return "[redacted]";
  }
  if (depth >= MAX_SAFE_DEPTH) {
    return "[nested value omitted]";
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const redacted = redactSecretText(value);
    return redacted.length <= MAX_SAFE_STRING_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_SAFE_STRING_CHARS)}\n[value clipped]`;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    const visible = value
      .slice(0, MAX_SAFE_ARRAY_ITEMS)
      .map((item) => safeJson(item, undefined, depth + 1));
    if (value.length > MAX_SAFE_ARRAY_ITEMS) {
      visible.push(`[${String(value.length - MAX_SAFE_ARRAY_ITEMS)} items omitted]`);
    }
    return visible;
  }
  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_SAFE_OBJECT_KEYS)) {
      if (childValue !== undefined) {
        output[childKey] = safeJson(childValue, childKey, depth + 1);
      }
    }
    if (Object.keys(value).length > MAX_SAFE_OBJECT_KEYS) {
      output._omitted = `${String(Object.keys(value).length - MAX_SAFE_OBJECT_KEYS)} keys omitted`;
    }
    return output;
  }
  return value === undefined ? null : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageText(message: ModelMessage): string {
  const content: unknown = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
}

function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length / 4) * 3 - padding);
}

function messageAttachmentParts(
  message: ModelMessage,
): Extract<UiMessageV14["parts"][number], { type: "attachment" }>[] {
  const content: unknown = message.content;
  if (message.role !== "user" || !Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (!isRecord(part)) {
      return [];
    }
    if (
      part.type === "file" &&
      typeof part.mediaType === "string" &&
      typeof part.data === "string"
    ) {
      return [
        {
          type: "attachment" as const,
          mediaType: part.mediaType,
          bytes: base64ByteLength(part.data),
        },
      ];
    }
    if (part.type === "image" && typeof part.image === "string") {
      return [
        {
          type: "attachment" as const,
          mediaType: "image/*",
          bytes: base64ByteLength(part.image),
        },
      ];
    }
    return [];
  });
}

function toThreadId(id: string): ThreadId {
  return threadIdSchema.parse(id);
}

function toThreadSummary(store: ThreadStore, record: ThreadRecord): ThreadSummary {
  return {
    id: toThreadId(record.id),
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: store.countTranscriptMessages(record.id),
  };
}

function toUiMessage(
  entry: ReturnType<ThreadStore["listRecentTranscriptMessages"]>["entries"][number],
): UiMessageV14 | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") {
    return undefined;
  }
  const text = redactSecretText(messageText(entry.message));
  return {
    sequence: entry.sequence,
    role: entry.message.role,
    createdAt: entry.createdAt,
    parts: [
      ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
      ...messageAttachmentParts(entry.message),
    ],
  };
}

function toOperationView(record: SequencedToolExecutionRecord): OperationView {
  const redacted = toRedactedToolExecutionRecordSummary(record);
  return {
    id: operationIdSchema.parse(redacted.id),
    sequence: record.sequence,
    toolCallId: redacted.toolCallId,
    agentName: redacted.agentName,
    toolName: redacted.toolName,
    createdAt: redacted.createdAt,
    outcome: {
      kind: redacted.outcome.kind,
      ...("reason" in redacted.outcome && redacted.outcome.reason !== undefined
        ? { reason: redacted.outcome.reason }
        : {}),
    },
    display: safeJson(redacted.display, undefined),
  };
}

function toPendingApproval(
  turnId: TurnId,
  event: Extract<SessionEvent, { readonly type: "confirmation-required" }>,
): PendingApproval {
  const safePreview = safeJson(event.input, undefined);
  const parsedExplanation =
    event.explanation === undefined
      ? undefined
      : approvalExplanationSchema.safeParse(redactSecretText(event.explanation));
  const safeDiff = event.diff === undefined ? undefined : safeJson(event.diff, undefined);
  const preview = isRecord(safePreview)
    ? {
        ...safePreview,
        ...(parsedExplanation?.success === true
          ? { [APPROVAL_EXPLANATION_PREVIEW_KEY]: parsedExplanation.data }
          : {}),
        ...(safeDiff !== undefined ? { [APPROVAL_DIFF_PREVIEW_KEY]: safeDiff } : {}),
      }
    : safePreview;
  return {
    id: approvalIdSchema.parse(event.approvalId),
    turnId,
    agentName: event.agentName,
    toolName: event.toolName,
    preview,
    ...(event.reason !== undefined ? { reason: redactSecretText(event.reason) } : {}),
  };
}

export class RuntimeService {
  readonly runtimeInstanceId: RuntimeInstanceId;

  private readonly engine: RuntimeServiceEngine;
  private readonly store: ThreadStore;
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly runtimeVersion: string;
  private readonly maxFrameBytes: number;
  private readonly idempotencyCacheEntries: number;
  private readonly reasoningSummaryProjector:
    | RuntimeServiceOptions["reasoningSummaryProjector"]
    | undefined;
  private readonly attachmentStore: AttachmentStore | undefined;
  private readonly sessions = new Map<string, RuntimeServiceSession>();
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly activeTurnOwners = new Map<TurnId, ThreadId>();
  private readonly settledTurnOwners = new Map<TurnId, ThreadId>();
  private readonly pendingApprovals = new Map<string, PendingApprovalState>();
  private readonly pendingUserInputs = new Map<SessionUserInputRequestId, PendingUserInputState>();
  private readonly listeners = new Set<(event: RuntimeEventEnvelopeV14) => void>();
  private readonly fatalErrorListeners = new Set<(error: unknown) => void>();
  private readonly userInputListeners = new Set<
    (event: RuntimeUserInputInteractionEvent) => void
  >();
  private readonly mutationRequests: MutationRequestCache;
  private sequence = 0;
  private closing = false;
  private userInputAvailable = false;

  constructor(
    engine: RuntimeServiceEngine,
    store: ThreadStore,
    options: RuntimeServiceOptions = {},
  ) {
    this.engine = engine;
    this.store = store;
    this.serverName = options.serverName ?? "roll-runtime";
    this.serverVersion = options.serverVersion ?? "1.0";
    this.runtimeVersion = options.runtimeVersion ?? "development";
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.idempotencyCacheEntries =
      options.idempotencyCacheEntries ?? DEFAULT_IDEMPOTENCY_CACHE_ENTRIES;
    this.mutationRequests = new MutationRequestCache(this.idempotencyCacheEntries);
    this.reasoningSummaryProjector = options.reasoningSummaryProjector;
    this.attachmentStore = options.attachmentStore;
    this.runtimeInstanceId = runtimeInstanceIdSchema.parse(randomUUID());
  }

  initialize(params: InitializeParams): InitializeResult {
    this.assertOpen();
    let protocolVersion: RuntimeProtocolVersion | undefined;
    for (const candidate of params.protocolVersions) {
      const parsed = runtimeProtocolVersionSchema.safeParse(candidate);
      if (parsed.success) {
        protocolVersion = parsed.data;
        break;
      }
    }
    if (protocolVersion === undefined) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.protocolVersionUnsupported,
        `不支持客户端协议版本：${params.protocolVersions.join(", ")}`,
        {
          details: {
            supportedVersions: SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
          },
        },
      );
    }
    const legacyFeatures = RUNTIME_FEATURES_V13.filter(
      (feature) => feature !== "reasoning-summary" || this.reasoningSummaryProjector !== undefined,
    );
    const commonResult = {
      protocolVersion,
      runtimeInstanceId: this.runtimeInstanceId,
      server: {
        name: this.serverName,
        version: this.serverVersion,
        runtimeVersion: this.runtimeVersion,
      },
      features: legacyFeatures,
      limits: {
        maxFrameBytes: this.maxFrameBytes,
        maxPageSize: DEFAULT_MAX_PAGE_SIZE,
        idempotencyCacheEntries: this.idempotencyCacheEntries,
      },
    };
    if (protocolVersion === "1.4") {
      const storeLimits = this.attachmentStore?.limits;
      return {
        ...commonResult,
        protocolVersion,
        features:
          this.attachmentStore !== undefined
            ? [...legacyFeatures, "attachments" as const]
            : [...legacyFeatures],
        limits: {
          ...commonResult.limits,
          eventReplay: true,
          maxAttachmentBytes: storeLimits?.maxAttachmentBytes ?? RUNTIME_V14_MAX_ATTACHMENT_BYTES,
          maxAttachmentChunkBytes:
            storeLimits?.maxAttachmentChunkBytes ?? RUNTIME_V14_MAX_ATTACHMENT_CHUNK_BYTES,
          maxTurnAttachments: RUNTIME_V14_MAX_TURN_ATTACHMENTS,
          maxStagedAttachments:
            storeLimits?.maxStagedAttachments ?? RUNTIME_V14_MAX_STAGED_ATTACHMENTS,
        },
      };
    }
    return protocolVersion === "1.3"
      ? {
          ...commonResult,
          protocolVersion,
          limits: { ...commonResult.limits, eventReplay: true },
        }
      : {
          ...commonResult,
          protocolVersion,
          limits: { ...commonResult.limits, eventReplay: false },
        };
  }

  onEvent(listener: (event: RuntimeEventEnvelopeV14) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onFatalError(listener: (error: unknown) => void): () => void {
    this.fatalErrorListeners.add(listener);
    return () => {
      this.fatalErrorListeners.delete(listener);
    };
  }

  onUserInputInteraction(listener: (event: RuntimeUserInputInteractionEvent) => void): () => void {
    this.userInputListeners.add(listener);
    return () => {
      this.userInputListeners.delete(listener);
    };
  }

  setUserInputAvailable(available: boolean): void {
    if (this.userInputAvailable === available) {
      return;
    }
    this.userInputAvailable = available;
    if (!available) {
      this.cancelAllPendingUserInputs("当前客户端已撤销用户输入处理能力");
    }
    for (const session of this.sessions.values()) {
      session.setUserInputAvailable?.(available);
    }
  }

  listThreads(params: RuntimeMethodParams<"thread.list">): RuntimeMethodResult<"thread.list"> {
    this.assertOpen();
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.invalidParams,
        "thread.list cursor 超出安全整数范围",
      );
    }
    const records = this.store.listThreads();
    const items = records
      .slice(offset, offset + params.limit)
      .map((record) => toThreadSummary(this.store, record));
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < records.length ? String(nextOffset) : null,
    };
  }

  async createThread(
    params: RuntimeMethodParams<"thread.create">,
  ): Promise<RuntimeMethodResult<"thread.create">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.threadCreate,
      params,
      async () => {
        this.assertOpen();
        const session = await this.engine.createSession(
          params.title !== undefined ? { title: params.title } : {},
        );
        this.rememberSession(session);
        return {
          thread: toThreadSummary(this.store, this.requireThread(session.id)),
        };
      },
    );
  }

  async openThread(params: RuntimeMethodParams<"thread.open">): Promise<RuntimeThreadSnapshot> {
    await this.requireSession(params.threadId);
    return this.snapshotThread({
      threadId: params.threadId,
      limit: 100,
    });
  }

  snapshotThread(params: RuntimeMethodParams<"thread.snapshot">): RuntimeThreadSnapshot {
    this.assertOpen();
    const record = this.requireThread(params.threadId);
    const messagePage = this.store.listRecentTranscriptMessages(params.threadId, {
      ...(params.messageBeforeSequence !== undefined
        ? { beforeSequence: params.messageBeforeSequence }
        : {}),
      limit: params.limit,
    });
    const operationPage = this.store.listRecentToolExecutions(params.threadId, {
      ...(params.operationBeforeSequence !== undefined
        ? { beforeSequence: params.operationBeforeSequence }
        : {}),
      limit: params.limit,
    });
    const active = this.activeTurns.get(params.threadId);
    const activeTurn: ActiveTurn | undefined =
      active === undefined
        ? undefined
        : {
            id: active.turnId,
            status: active.status,
            startedAt: active.startedAt,
          };
    return {
      thread: toThreadSummary(this.store, record),
      messages: {
        items: messagePage.entries.flatMap((entry) => {
          const projected = toUiMessage(entry);
          return projected === undefined ? [] : [projected];
        }),
        nextBeforeSequence: messagePage.nextBeforeSequence ?? null,
      },
      operations: {
        items: operationPage.entries.map(toOperationView),
        nextBeforeSequence: operationPage.nextBeforeSequence ?? null,
      },
      ...(activeTurn !== undefined ? { activeTurn } : {}),
      pendingApprovals: [...this.pendingApprovals.values()]
        .filter((pending) => pending.threadId === params.threadId)
        .map((pending) => pending.approval),
      transcriptCompleteness: this.store.getTranscriptCompleteness(params.threadId),
      eventCursor: this.store.getRuntimeEventCursor(params.threadId),
    };
  }

  resumeEvents(params: RuntimeEventsResumeParams): RuntimeEventReplayBatch {
    this.assertOpen();
    this.requireThread(params.threadId);
    try {
      return this.store.resumeRuntimeEvents(params.threadId, params.afterCursor);
    } catch (error: unknown) {
      if (error instanceof RuntimeEventCursorExpiredError) {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.eventCursorExpired,
          "Runtime Event cursor 已超出当前 Thread 的保留窗口，请回退到 thread.snapshot",
          { details: { threadId: params.threadId } },
        );
      }
      if (error instanceof RuntimeEventCursorGapError) {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.eventCursorGap,
          "Runtime Event cursor 与当前 Thread 事件日志不连续，请回退到 thread.snapshot",
          { details: { threadId: params.threadId } },
        );
      }
      throw error;
    }
  }

  async renameThread(
    params: RuntimeMethodParams<"thread.rename">,
  ): Promise<RuntimeMethodResult<"thread.rename">> {
    return this.mutationRequests.run(params.requestId, RUNTIME_METHODS.threadRename, params, () => {
      this.assertOpen();
      this.requireThread(params.threadId);
      this.store.updateTitle(params.threadId, params.title);
      return {
        thread: toThreadSummary(this.store, this.requireThread(params.threadId)),
      };
    });
  }

  async deleteThread(
    params: RuntimeMethodParams<"thread.delete">,
  ): Promise<RuntimeMethodResult<"thread.delete">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.threadDelete,
      params,
      async () => {
        this.assertOpen();
        this.requireThread(params.threadId);
        if (this.activeTurns.has(params.threadId)) {
          throw new RuntimeServiceError(
            RUNTIME_ERROR_CODES.threadBusy,
            `Thread "${params.threadId}" 仍有活动 Turn`,
            { retryable: true },
          );
        }
        const session = this.sessions.get(params.threadId);
        if (session !== undefined) {
          await session.close();
          this.sessions.delete(params.threadId);
        }
        this.attachmentStore?.releaseThread(params.threadId);
        this.store.deleteThread(params.threadId);
        return { deleted: true };
      },
    );
  }

  async detachThread(
    params: RuntimeMethodParams<"thread.detach">,
  ): Promise<RuntimeMethodResult<"thread.detach">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.threadDetach,
      params,
      async () => {
        this.assertOpen();
        this.requireThread(params.threadId);
        if (this.activeTurns.has(params.threadId)) {
          return { detached: false };
        }
        const session = this.sessions.get(params.threadId);
        if (session === undefined) {
          return { detached: false };
        }
        await session.close();
        this.sessions.delete(params.threadId);
        return { detached: true };
      },
    );
  }

  async threadCapabilities(
    params: RuntimeMethodParams<"thread.capabilities">,
  ): Promise<RuntimeMethodResult<"thread.capabilities">> {
    const session = await this.requireSession(params.threadId);
    return {
      manifest: safeJson(
        createSafeCapabilitySnapshot(
          session.getCapabilityManifest(),
          session.getCapabilityTurnContext(),
        ),
        undefined,
      ),
    };
  }

  async startTurn(
    params: LatestRuntimeMethodParams<"turn.start">,
  ): Promise<LatestRuntimeMethodResult<"turn.start">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.turnStart,
      params,
      async () => {
        this.assertOpen();
        const existingOwner = this.findTurnOwner(params.turnId, params.threadId);
        if (existingOwner !== undefined) {
          if (existingOwner === params.threadId) {
            return { accepted: true, turnId: params.turnId };
          }
          throw new RuntimeServiceError(
            RUNTIME_ERROR_CODES.turnAlreadyActive,
            `Turn "${params.turnId}" 已属于另一个 Thread`,
          );
        }
        if (this.activeTurns.has(params.threadId)) {
          throw new RuntimeServiceError(
            RUNTIME_ERROR_CODES.turnAlreadyActive,
            `Thread "${params.threadId}" 已有活动 Turn`,
            { retryable: true },
          );
        }
        const session = await this.requireSession(params.threadId);
        const ownerAfterOpen = this.findTurnOwner(params.turnId, params.threadId);
        if (ownerAfterOpen !== undefined) {
          if (ownerAfterOpen === params.threadId) {
            return { accepted: true, turnId: params.turnId };
          }
          throw new RuntimeServiceError(
            RUNTIME_ERROR_CODES.turnAlreadyActive,
            `Turn "${params.turnId}" 已属于另一个 Thread`,
          );
        }
        if (this.activeTurns.has(params.threadId)) {
          throw new RuntimeServiceError(
            RUNTIME_ERROR_CODES.turnAlreadyActive,
            `Thread "${params.threadId}" 已有活动 Turn`,
            { retryable: true },
          );
        }
        const attachments = this.resolveTurnAttachments(params);
        const state: ActiveTurnState = {
          threadId: params.threadId,
          turnId: params.turnId,
          session,
          startedAt: new Date().toISOString(),
          status: "running",
          interactionFailure: undefined,
        };
        this.activeTurns.set(params.threadId, state);
        this.activeTurnOwners.set(params.turnId, params.threadId);
        try {
          this.emit(params.threadId, params.turnId, { type: "turn.started" });
        } catch (error: unknown) {
          this.activeTurns.delete(params.threadId);
          this.activeTurnOwners.delete(params.turnId);
          throw error;
        }
        this.driveTurn(state, params.input.text, attachments).catch(() => undefined);
        return { accepted: true, turnId: params.turnId };
      },
    );
  }

  async cancelTurn(
    params: RuntimeMethodParams<"turn.cancel">,
  ): Promise<RuntimeMethodResult<"turn.cancel">> {
    return this.mutationRequests.run(params.requestId, RUNTIME_METHODS.turnCancel, params, () => {
      this.assertOpen();
      const state = this.activeTurns.get(params.threadId);
      if (state === undefined || state.turnId !== params.turnId) {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.turnNotFound,
          `Turn "${params.turnId}" 不存在或已结束`,
        );
      }
      state.status = "cancelling";
      let cancelling = false;
      try {
        this.cancelPendingUserInputsForTurn(params.turnId, "Turn 已由客户端取消");
        this.cancelPendingApprovalsForTurn(params.turnId, {
          status: "cancelled",
          reason: "Turn 已由客户端取消",
        });
      } finally {
        cancelling = state.session.cancel();
      }
      return { cancelling };
    });
  }

  async respondApproval(
    params: LatestRuntimeMethodParams<"approval.respond">,
  ): Promise<LatestRuntimeMethodResult<"approval.respond">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.approvalRespond,
      params,
      () =>
        this.resolvePendingApproval(
          params,
          params.decision === "approve"
            ? { decision: "approve" }
            : {
                decision: "reject",
                ...(params.reason !== undefined ? { reason: params.reason } : {}),
              },
        ),
    );
  }

  resolvePendingApproval(
    identity: RuntimeApprovalIdentity,
    decision: RuntimeApprovalDecision,
  ): RuntimeMethodResult<"approval.respond"> {
    this.assertOpen();
    const pending = this.requirePendingApproval(identity);
    const resolved =
      decision.decision === "approve"
        ? pending.session.approve(identity.approvalId, decision.scope)
        : pending.session.reject(identity.approvalId, decision.reason);
    this.pendingApprovals.delete(identity.approvalId);
    if (!resolved) {
      this.emitApprovalResolved(pending, {
        status: "cancelled",
        reason: "审批已失效",
      });
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.approvalNotFound,
        `Approval "${identity.approvalId}" 已失效`,
      );
    }
    this.emitApprovalResolved(
      pending,
      decision.decision === "approve"
        ? { status: "resolved", decision: "approve" }
        : {
            status: "resolved",
            decision: "reject",
            ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
          },
    );
    return { resolved: true };
  }

  getPendingApprovalExpiresAt(identity: RuntimeApprovalIdentity): string | undefined {
    return this.findPendingApproval(identity)?.expiresAt;
  }

  async stageAttachment(
    params: LatestRuntimeMethodParams<"attachment.stage">,
  ): Promise<LatestRuntimeMethodResult<"attachment.stage">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.attachmentStage,
      params,
      () => {
        this.assertOpen();
        this.requireThread(params.threadId);
        const result = this.requireAttachmentStore().stage({
          threadId: params.threadId,
          fileName: params.fileName,
          mediaType: params.mediaType,
          bytes: params.bytes,
          sha256: params.sha256,
          source: params.source,
          sourcePath: params.sourcePath,
        });
        if (!result.ok) {
          this.throwAttachmentFailure(result);
        }
        return {
          attachmentId: result.attachmentId,
          state: result.state,
          ...(result.descriptor !== undefined ? { descriptor: result.descriptor } : {}),
        };
      },
    );
  }

  async appendAttachmentChunk(
    params: LatestRuntimeMethodParams<"attachment.chunk">,
  ): Promise<LatestRuntimeMethodResult<"attachment.chunk">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.attachmentChunk,
      params,
      () => {
        this.assertOpen();
        const result = this.requireAttachmentStore().appendChunk({
          threadId: params.threadId,
          attachmentId: params.attachmentId,
          sequence: params.sequence,
          dataBase64: params.dataBase64,
        });
        if (!result.ok) {
          this.throwAttachmentFailure(result);
        }
        return { receivedBytes: result.receivedBytes, nextSequence: result.nextSequence };
      },
    );
  }

  async commitAttachment(
    params: LatestRuntimeMethodParams<"attachment.commit">,
  ): Promise<LatestRuntimeMethodResult<"attachment.commit">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.attachmentCommit,
      params,
      () => {
        this.assertOpen();
        const result = this.requireAttachmentStore().commit({
          threadId: params.threadId,
          attachmentId: params.attachmentId,
        });
        if (!result.ok) {
          this.throwAttachmentFailure(result);
        }
        return { descriptor: result.descriptor };
      },
    );
  }

  async releaseAttachment(
    params: LatestRuntimeMethodParams<"attachment.release">,
  ): Promise<LatestRuntimeMethodResult<"attachment.release">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.attachmentRelease,
      params,
      () => {
        this.assertOpen();
        const result = this.requireAttachmentStore().release({
          threadId: params.threadId,
          attachmentId: params.attachmentId,
        });
        return { released: result.released };
      },
    );
  }

  private requireAttachmentStore(): AttachmentStore {
    if (this.attachmentStore === undefined) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        "Runtime 未配置附件存储，attachments 能力不可用",
      );
    }
    return this.attachmentStore;
  }

  private throwAttachmentFailure(failure: AttachmentStoreFailure): never {
    throw new RuntimeServiceError(failure.code, failure.message, {
      ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
    });
  }

  private resolveTurnAttachments(
    params: LatestRuntimeMethodParams<"turn.start">,
  ): SessionAttachment[] | undefined {
    const ids = params.input.attachments;
    if (ids === undefined || ids.length === 0) {
      return undefined;
    }
    const store = this.requireAttachmentStore();
    const seen = new Set<string>();
    const resolved: SessionAttachment[] = [];
    for (const attachmentId of ids) {
      if (seen.has(attachmentId)) {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.invalidParams,
          `附件 "${attachmentId}" 在同一 Turn 中重复引用`,
        );
      }
      seen.add(attachmentId);
      const read = store.readCommitted({ threadId: params.threadId, attachmentId });
      if (!read.ok) {
        this.throwAttachmentFailure(read);
      }
      resolved.push({ data: read.dataBase64, mediaType: read.descriptor.mediaType });
    }
    return resolved;
  }

  private cancelPendingApproval(
    identity: RuntimeApprovalIdentity,
    resolution: Extract<ApprovalResolution, { readonly status: "cancelled" | "expired" }>,
  ): boolean {
    const pending = this.findPendingApproval(identity);
    if (pending === undefined) {
      return false;
    }
    this.pendingApprovals.delete(identity.approvalId);
    this.emitApprovalResolved(pending, resolution);
    return true;
  }

  async failPendingApprovalInteraction(
    identity: RuntimeApprovalIdentity,
    reason: string,
    resolution: Extract<ApprovalResolution, { readonly status: "cancelled" | "expired" }> = {
      status: "cancelled",
      reason,
    },
  ): Promise<boolean> {
    const pending = this.findPendingApproval(identity);
    if (pending === undefined) {
      return false;
    }
    const activeTurn = this.activeTurns.get(identity.threadId);
    if (activeTurn !== undefined && activeTurn.turnId === identity.turnId) {
      activeTurn.interactionFailure = reason;
    }
    this.pendingApprovals.delete(identity.approvalId);
    try {
      this.emitApprovalResolved(pending, resolution);
    } finally {
      pending.session.cancel();
    }
    return true;
  }

  resolvePendingUserInput(requestId: SessionUserInputRequestId, result: UserInputResult): boolean {
    const pending = this.pendingUserInputs.get(requestId);
    if (pending === undefined) {
      return false;
    }
    let normalized: UserInputResult;
    try {
      normalized = normalizeUserInputResultForForm(pending.form, result);
    } catch {
      this.cancelPendingUserInput(requestId, "用户输入不符合原始表单约束");
      return false;
    }
    this.pendingUserInputs.delete(requestId);
    const resolved = pending.session.resolveUserInput?.(requestId, normalized) ?? false;
    if (!resolved) {
      const reason = "用户输入请求已失效";
      pending.session.cancelUserInput?.(requestId, reason);
      this.restoreRunningStatus(pending);
      this.emitUserInputInteraction({
        type: "settled",
        requestId,
        threadId: pending.threadId,
        turnId: pending.turnId,
        reason,
      });
      return false;
    }
    this.restoreRunningStatus(pending);
    this.emitUserInputInteraction({
      type: "settled",
      requestId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      reason: normalized.status === "submitted" ? "用户已提交输入" : "用户已取消输入",
    });
    return resolved;
  }

  cancelPendingUserInput(requestId: SessionUserInputRequestId, reason: string): boolean {
    const pending = this.pendingUserInputs.get(requestId);
    if (pending === undefined) {
      return false;
    }
    this.pendingUserInputs.delete(requestId);
    const cancelled = pending.session.cancelUserInput?.(requestId, reason) ?? false;
    this.restoreRunningStatus(pending);
    this.emitUserInputInteraction({
      type: "settled",
      requestId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      reason,
    });
    return cancelled;
  }

  getOperation(params: RuntimeMethodParams<"operation.get">): RuntimeMethodResult<"operation.get"> {
    this.assertOpen();
    this.requireThread(params.threadId);
    const record = this.store.getToolExecution(params.threadId, params.operationId);
    return {
      operation: record === undefined ? null : toOperationView(record),
    };
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.setUserInputAvailable(false);
    for (const turn of this.activeTurns.values()) {
      turn.session.cancel();
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.activeTurns.clear();
    this.activeTurnOwners.clear();
    this.settledTurnOwners.clear();
    this.pendingApprovals.clear();
    this.pendingUserInputs.clear();
    this.userInputListeners.clear();
    this.attachmentStore?.close();
    await Promise.allSettled(sessions.map((session) => session.close()));
    this.mutationRequests.clear();
    this.fatalErrorListeners.clear();
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new RuntimeServiceError(RUNTIME_ERROR_CODES.runtimeClosing, "Runtime 正在关闭", {
        retryable: true,
      });
    }
  }

  private requireThread(threadId: string): ThreadRecord {
    const record = this.store.getThread(threadId);
    if (record === undefined) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.threadNotFound,
        `Thread "${threadId}" 不存在`,
      );
    }
    return record;
  }

  private async requireSession(threadId: ThreadId): Promise<RuntimeServiceSession> {
    this.assertOpen();
    this.requireThread(threadId);
    const existing = this.sessions.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const session = await this.engine.resumeSession(threadId);
    this.rememberSession(session);
    return session;
  }

  private rememberSession(session: RuntimeServiceSession): void {
    session.setUserInputAvailable?.(this.userInputAvailable);
    this.sessions.set(session.id, session);
  }

  private emit(threadId: ThreadId, turnId: TurnId | undefined, event: RuntimeEvent): void {
    const timestamp = new Date().toISOString();
    const commonEnvelope = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: this.runtimeInstanceId,
      sequence: this.sequence,
      timestamp,
      threadId,
      ...(turnId !== undefined ? { turnId } : {}),
    } as const;
    const durableEvent = runtimeDurableEventV13Schema.safeParse(event);
    const envelope: RuntimeEventEnvelopeV14 = durableEvent.success
      ? (() => {
          let stored: StoredRuntimeEvent;
          try {
            stored = this.store.appendRuntimeEvent({
              threadId,
              ...(turnId === undefined ? {} : { turnId }),
              timestamp,
              event: durableEvent.data,
            });
          } catch (error: unknown) {
            this.notifyFatalError(error);
            throw error;
          }
          return {
            ...commonEnvelope,
            durability: "durable" as const,
            eventId: stored.eventId,
            cursor: stored.cursor,
            event: durableEvent.data,
          };
        })()
      : {
          ...commonEnvelope,
          durability: "ephemeral",
          event: runtimeEphemeralEventV13Schema.parse(event),
        };
    this.sequence += 1;
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch {
        // Event consumers are observers. A broken transport/listener must not corrupt Runtime state.
      }
    }
  }

  private notifyFatalError(error: unknown): void {
    for (const turn of this.activeTurns.values()) {
      try {
        turn.session.cancel();
      } catch {
        // A cancellation failure must not replace the durable Store error that triggered shutdown.
      }
    }
    for (const listener of this.fatalErrorListeners) {
      try {
        listener(error);
      } catch {
        // Fatal observers are best-effort shutdown signals; the storage error remains primary.
      }
    }
  }

  private async driveTurn(
    state: ActiveTurnState,
    input: string,
    attachments: readonly SessionAttachment[] | undefined,
  ): Promise<void> {
    const projection: TurnProjectionState = {
      streamId: undefined,
      text: "",
      terminalEvent: undefined,
    };
    const sendInput =
      attachments !== undefined && attachments.length > 0 ? { text: input, attachments } : input;
    let terminalEvent: NonNullable<TurnProjectionState["terminalEvent"]>;
    try {
      for await (const event of state.session.send(sendInput)) {
        this.projectSessionEvent(state, projection, event);
      }
      terminalEvent = projection.terminalEvent ?? { type: "turn.completed" };
    } catch (error: unknown) {
      terminalEvent = projection.terminalEvent ?? {
        type: "turn.failed",
        stage: "execute",
        message: redactSecretText(errorMessage(error)),
      };
    } finally {
      if (this.activeTurns.get(state.threadId) === state) {
        this.activeTurns.delete(state.threadId);
      }
      this.settleTurnOwner(state);
    }
    this.emitTurnTerminal(state, terminalEvent);
  }

  private findTurnOwner(turnId: TurnId, expectedThreadId: ThreadId): ThreadId | undefined {
    const activeOwner = this.activeTurnOwners.get(turnId);
    if (activeOwner !== undefined) {
      return activeOwner;
    }
    const settledOwner = this.settledTurnOwners.get(turnId);
    if (settledOwner === expectedThreadId) {
      this.settledTurnOwners.delete(turnId);
      this.settledTurnOwners.set(turnId, settledOwner);
    }
    return settledOwner;
  }

  private settleTurnOwner(state: ActiveTurnState): void {
    if (this.activeTurnOwners.get(state.turnId) !== state.threadId) {
      return;
    }
    this.activeTurnOwners.delete(state.turnId);
    if (this.closing) {
      return;
    }
    this.settledTurnOwners.set(state.turnId, state.threadId);
    while (this.settledTurnOwners.size > this.idempotencyCacheEntries) {
      const oldestTurnId = this.settledTurnOwners.keys().next().value;
      if (oldestTurnId === undefined) {
        return;
      }
      this.settledTurnOwners.delete(oldestTurnId);
    }
  }

  private projectSessionEvent(
    state: ActiveTurnState,
    projection: TurnProjectionState,
    event: SessionEvent,
  ): void {
    switch (event.type) {
      case "message-start": {
        const streamId = streamIdSchema.parse(randomUUID());
        projection.streamId = streamId;
        projection.text = "";
        this.emit(state.threadId, state.turnId, {
          type: "message.started",
          streamId,
        });
        return;
      }
      case "text-delta": {
        const streamId = projection.streamId ?? streamIdSchema.parse(randomUUID());
        if (projection.streamId === undefined) {
          projection.streamId = streamId;
          this.emit(state.threadId, state.turnId, {
            type: "message.started",
            streamId,
          });
        }
        projection.text += event.delta;
        this.emit(state.threadId, state.turnId, {
          type: "message.delta",
          streamId,
          delta: event.delta,
        });
        return;
      }
      case "message-finish": {
        const streamId = projection.streamId ?? streamIdSchema.parse(randomUUID());
        this.emit(state.threadId, state.turnId, {
          type: "message.completed",
          streamId,
          text: redactSecretText(event.text || projection.text),
        });
        return;
      }
      case "reasoning-delta": {
        const summary = this.reasoningSummaryProjector?.(event.delta);
        if (summary !== undefined && summary.length > 0) {
          this.emit(state.threadId, state.turnId, {
            type: "reasoning.summary.delta",
            reasoningId: event.reasoningId,
            delta: redactSecretText(summary),
          });
        }
        return;
      }
      case "tool-call":
        this.emit(state.threadId, state.turnId, {
          type: "tool.started",
          toolCallId: event.toolCallId,
          agentName: event.agentName,
          toolName: event.toolName,
          input: safeJson(event.input, undefined),
        });
        return;
      case "tool-output-delta":
        this.emit(state.threadId, state.turnId, {
          type: "tool.output",
          toolCallId: event.toolCallId,
          agentName: event.agentName,
          toolName: event.toolName,
          stream: event.stream,
          delta: redactSecretText(event.delta),
        });
        return;
      case "tool-result":
        this.emit(state.threadId, state.turnId, {
          type: "tool.completed",
          toolCallId: event.toolCallId,
          agentName: event.agentName,
          toolName: event.toolName,
          ...(event.executionId !== undefined
            ? { operationId: operationIdSchema.parse(event.executionId) }
            : {}),
          ...(event.outcome !== undefined
            ? { outcome: this.projectToolOutcome(event.outcome) }
            : {}),
          display: safeJson(event.display, undefined),
        });
        return;
      case "confirmation-required": {
        const approval = toPendingApproval(state.turnId, event);
        this.pendingApprovals.set(approval.id, {
          threadId: state.threadId,
          session: state.session,
          approval,
          expiresAt: event.expiresAt,
        });
        this.emit(state.threadId, state.turnId, {
          type: "approval.required",
          approval,
        });
        return;
      }
      case "user-input-required": {
        if (
          !this.userInputAvailable ||
          state.session.resolveUserInput === undefined ||
          state.session.cancelUserInput === undefined
        ) {
          state.session.cancelUserInput?.(event.requestId, "当前客户端未协商用户输入处理能力");
          return;
        }
        const storedForm = userInputFormSchema.parse(event.form);
        const exposedForm = userInputFormSchema.parse(storedForm);
        const pending: PendingUserInputState = {
          requestId: event.requestId,
          threadId: state.threadId,
          turnId: state.turnId,
          session: state.session,
          form: storedForm,
          expiresAt: event.expiresAt,
        };
        this.pendingUserInputs.set(event.requestId, pending);
        state.status = "waiting-for-user";
        const delivered = this.emitUserInputInteraction({
          type: "required",
          requestId: event.requestId,
          threadId: state.threadId,
          turnId: state.turnId,
          form: exposedForm,
          expiresAt: event.expiresAt,
        });
        if (!delivered) {
          this.cancelPendingUserInput(event.requestId, "当前没有可处理用户输入请求的客户端");
        }
        return;
      }
      case "user-input-settled": {
        const pending = this.pendingUserInputs.get(event.requestId);
        if (pending === undefined) {
          return;
        }
        this.pendingUserInputs.delete(event.requestId);
        this.restoreRunningStatus(pending);
        this.emitUserInputInteraction({
          type: "settled",
          requestId: pending.requestId,
          threadId: pending.threadId,
          turnId: pending.turnId,
          reason: event.status === "submitted" ? "用户输入请求已结算" : "用户输入请求已取消",
        });
        return;
      }
      case "turn-cancelled": {
        projection.terminalEvent ??=
          state.interactionFailure === undefined
            ? {
                type: "turn.cancelled",
                reason: event.reason,
                message: redactSecretText(event.message),
              }
            : {
                type: "turn.failed",
                stage: "execute",
                message: redactSecretText(state.interactionFailure),
              };
        break;
      }
      case "error":
        projection.terminalEvent ??= {
          type: "turn.failed",
          stage: event.stage,
          message: redactSecretText(event.message),
        };
        break;
      case "debug":
      case "reasoning-start":
      case "reasoning-end":
      case "step-finish":
      case "compaction-start":
      case "context-compacted":
        break;
    }
  }

  private projectToolOutcome(outcome: ToolOutcome): OperationView["outcome"] {
    return {
      kind: outcome.kind,
      ...("reason" in outcome && outcome.reason !== undefined
        ? { reason: redactSecretText(outcome.reason) }
        : {}),
    };
  }

  private findPendingApproval(identity: RuntimeApprovalIdentity): PendingApprovalState | undefined {
    const pending = this.pendingApprovals.get(identity.approvalId);
    if (
      pending === undefined ||
      pending.threadId !== identity.threadId ||
      pending.approval.turnId !== identity.turnId
    ) {
      return undefined;
    }
    return pending;
  }

  private requirePendingApproval(identity: RuntimeApprovalIdentity): PendingApprovalState {
    const pending = this.findPendingApproval(identity);
    if (pending === undefined) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.approvalNotFound,
        `Approval "${identity.approvalId}" 不存在或已失效`,
      );
    }
    return pending;
  }

  private emitApprovalResolved(
    pending: PendingApprovalState,
    resolution: ApprovalResolution,
  ): void {
    const safeResolution: ApprovalResolution =
      "reason" in resolution && resolution.reason !== undefined
        ? { ...resolution, reason: redactSecretText(resolution.reason) }
        : resolution;
    this.emit(pending.threadId, pending.approval.turnId, {
      type: "approval.resolved",
      approvalId: pending.approval.id,
      resolution: safeResolution,
    });
  }

  private cancelPendingApprovalsForTurn(
    turnId: TurnId,
    resolution: Extract<ApprovalResolution, { readonly status: "cancelled" | "expired" }>,
  ): void {
    const pendingForTurn = [...this.pendingApprovals.values()].filter(
      (pending) => pending.approval.turnId === turnId,
    );
    let firstListenerError: unknown;
    for (const pending of pendingForTurn) {
      try {
        this.cancelPendingApproval(
          {
            threadId: pending.threadId,
            turnId: pending.approval.turnId,
            approvalId: pending.approval.id,
          },
          resolution,
        );
      } catch (error: unknown) {
        firstListenerError ??= error;
      }
    }
    if (firstListenerError !== undefined) {
      throw firstListenerError;
    }
  }

  private cancelPendingUserInputsForTurn(turnId: TurnId, reason: string): void {
    const requestIds = [...this.pendingUserInputs.values()]
      .filter((pending) => pending.turnId === turnId)
      .map((pending) => pending.requestId);
    for (const requestId of requestIds) {
      this.cancelPendingUserInput(requestId, reason);
    }
  }

  private cancelAllPendingUserInputs(reason: string): void {
    for (const requestId of [...this.pendingUserInputs.keys()]) {
      this.cancelPendingUserInput(requestId, reason);
    }
  }

  private restoreRunningStatus(pending: PendingUserInputState): void {
    const active = this.activeTurns.get(pending.threadId);
    if (
      active !== undefined &&
      active.turnId === pending.turnId &&
      active.status === "waiting-for-user"
    ) {
      active.status = "running";
    }
  }

  private emitUserInputInteraction(event: RuntimeUserInputInteractionEvent): boolean {
    let delivered = false;
    for (const listener of this.userInputListeners) {
      try {
        listener(event);
        delivered = true;
      } catch {
        // Interaction observers cannot corrupt Runtime state. Deadlines remain fail-closed.
      }
    }
    return delivered;
  }

  private emitTurnTerminal(
    state: ActiveTurnState,
    event: Extract<
      RuntimeEvent,
      {
        readonly type: "turn.completed" | "turn.cancelled" | "turn.failed";
      }
    >,
  ): void {
    this.cancelPendingUserInputsForTurn(state.turnId, `Turn 已终止：${event.type}`);
    this.cancelPendingApprovalsForTurn(
      state.turnId,
      event.type === "turn.cancelled" && event.reason === "timeout"
        ? { status: "expired", reason: "Turn 已超时" }
        : { status: "cancelled", reason: `Turn 已终止：${event.type}` },
    );
    this.emit(state.threadId, state.turnId, event);
  }
}
