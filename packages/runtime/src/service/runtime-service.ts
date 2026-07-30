import { createHash, randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import {
  RUNTIME_ERROR_CODES,
  RUNTIME_FEATURES,
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  approvalIdSchema,
  operationIdSchema,
  parseRuntimeMethodResult,
  runtimeInstanceIdSchema,
  streamIdSchema,
  threadIdSchema,
  type ActiveTurn,
  type InitializeParams,
  type InitializeResult,
  type JsonValue,
  type OperationView,
  type PendingApproval,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeInstanceId,
  type RuntimeMethodParams,
  type RuntimeMethodResult,
  type RuntimeProtocolErrorData,
  type ThreadId,
  type ThreadSummary,
  type TurnId,
  type UiMessage,
} from "@roll-agent/protocol";
import type { AgentSession } from "../engine/agent-session.ts";
import { createSafeCapabilitySnapshot } from "../engine/capability-manifest.ts";
import type { SessionEvent } from "../types/events.ts";
import {
  isSensitiveFieldName,
  redactSecretText,
  toRedactedToolExecutionRecordSummary,
} from "../tool-bridge/tool-execution-record.ts";
import type { ToolOutcome } from "../tool-bridge/normalize-result.ts";
import {
  ThreadStore,
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
  "providerOptions",
  "raw",
  "secret",
  "token",
]);

type RollErrorCode = RuntimeProtocolErrorData["rollCode"];

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
>;

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
}

interface ActiveTurnState {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly session: RuntimeServiceSession;
  readonly startedAt: string;
  status: ActiveTurn["status"];
}

interface TurnProjectionState {
  streamId: ReturnType<typeof streamIdSchema.parse> | undefined;
  text: string;
  terminalEmitted: boolean;
}

interface PendingApprovalState {
  readonly threadId: ThreadId;
  readonly session: RuntimeServiceSession;
  readonly approval: PendingApproval;
}

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
  | typeof RUNTIME_METHODS.approvalRespond;

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
    params: RuntimeMethodParams<TMethod>,
    action: () => RuntimeMethodResult<TMethod> | Promise<RuntimeMethodResult<TMethod>>,
  ): Promise<RuntimeMethodResult<TMethod>> {
    const fingerprint = mutationRequestFingerprint(params);
    const inFlight = this.inFlight.get(requestId);
    if (inFlight !== undefined) {
      this.assertMatchingRequest(requestId, method, fingerprint, inFlight);
      return inFlight.response.then((result) => parseRuntimeMethodResult(method, result));
    }
    const settled = this.settled.get(requestId);
    if (settled !== undefined) {
      this.assertMatchingRequest(requestId, method, fingerprint, settled);
      this.settled.delete(requestId);
      this.settled.set(requestId, settled);
      return settled.response.then((result) => parseRuntimeMethodResult(method, result));
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
): UiMessage | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") {
    return undefined;
  }
  const text = redactSecretText(messageText(entry.message));
  return {
    sequence: entry.sequence,
    role: entry.message.role,
    createdAt: entry.createdAt,
    parts: text.length > 0 ? [{ type: "text", text }] : [],
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
  return {
    id: approvalIdSchema.parse(event.approvalId),
    turnId,
    agentName: event.agentName,
    toolName: event.toolName,
    preview: safeJson(event.input, undefined),
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
  private readonly sessions = new Map<string, RuntimeServiceSession>();
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly activeTurnOwners = new Map<TurnId, ThreadId>();
  private readonly settledTurnOwners = new Map<TurnId, ThreadId>();
  private readonly pendingApprovals = new Map<string, PendingApprovalState>();
  private readonly listeners = new Set<(event: RuntimeEventEnvelope) => void>();
  private readonly mutationRequests: MutationRequestCache;
  private sequence = 0;
  private closing = false;

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
    this.runtimeInstanceId = runtimeInstanceIdSchema.parse(randomUUID());
  }

  initialize(params: InitializeParams): InitializeResult {
    if (!params.protocolVersions.includes(RUNTIME_PROTOCOL_VERSION)) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.protocolVersionUnsupported,
        `不支持客户端协议版本：${params.protocolVersions.join(", ")}`,
        {
          details: {
            supportedVersions: [RUNTIME_PROTOCOL_VERSION],
          },
        },
      );
    }
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: this.runtimeInstanceId,
      server: {
        name: this.serverName,
        version: this.serverVersion,
        runtimeVersion: this.runtimeVersion,
      },
      features: RUNTIME_FEATURES.filter(
        (feature) =>
          feature !== "reasoning-summary" || this.reasoningSummaryProjector !== undefined,
      ),
      limits: {
        maxFrameBytes: this.maxFrameBytes,
        maxPageSize: DEFAULT_MAX_PAGE_SIZE,
        eventReplay: false,
        idempotencyCacheEntries: this.idempotencyCacheEntries,
      },
    };
  }

  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
        this.sessions.set(session.id, session);
        return {
          thread: toThreadSummary(this.store, this.requireThread(session.id)),
        };
      },
    );
  }

  async openThread(
    params: RuntimeMethodParams<"thread.open">,
  ): Promise<RuntimeMethodResult<"thread.open">> {
    await this.requireSession(params.threadId);
    return this.snapshotThread({
      threadId: params.threadId,
      limit: 100,
    });
  }

  snapshotThread(
    params: RuntimeMethodParams<"thread.snapshot">,
  ): RuntimeMethodResult<"thread.snapshot"> {
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
    };
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
    params: RuntimeMethodParams<"turn.start">,
  ): Promise<RuntimeMethodResult<"turn.start">> {
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
        const state: ActiveTurnState = {
          threadId: params.threadId,
          turnId: params.turnId,
          session,
          startedAt: new Date().toISOString(),
          status: "running",
        };
        this.activeTurns.set(params.threadId, state);
        this.activeTurnOwners.set(params.turnId, params.threadId);
        this.emit(params.threadId, params.turnId, { type: "turn.started" });
        this.driveTurn(state, params.input.text).catch(() => undefined);
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
      return { cancelling: state.session.cancel() };
    });
  }

  async respondApproval(
    params: RuntimeMethodParams<"approval.respond">,
  ): Promise<RuntimeMethodResult<"approval.respond">> {
    return this.mutationRequests.run(
      params.requestId,
      RUNTIME_METHODS.approvalRespond,
      params,
      () => {
        this.assertOpen();
        const pending = this.pendingApprovals.get(params.approvalId);
        if (
          pending === undefined ||
          pending.threadId !== params.threadId ||
          pending.approval.turnId !== params.turnId
        ) {
          throw new RuntimeServiceError(
            RUNTIME_ERROR_CODES.approvalNotFound,
            `Approval "${params.approvalId}" 不存在或已失效`,
          );
        }
        const resolved =
          params.decision === "approve"
            ? pending.session.approve(params.approvalId)
            : pending.session.reject(params.approvalId, params.reason);
        if (!resolved) {
          throw new RuntimeServiceError(
            RUNTIME_ERROR_CODES.approvalNotFound,
            `Approval "${params.approvalId}" 已失效`,
          );
        }
        this.pendingApprovals.delete(params.approvalId);
        return { resolved: true };
      },
    );
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
    for (const turn of this.activeTurns.values()) {
      turn.session.cancel();
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.activeTurns.clear();
    this.activeTurnOwners.clear();
    this.settledTurnOwners.clear();
    this.pendingApprovals.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
    this.mutationRequests.clear();
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
    this.sessions.set(threadId, session);
    return session;
  }

  private emit(threadId: ThreadId, turnId: TurnId | undefined, event: RuntimeEvent): void {
    const envelope: RuntimeEventEnvelope = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: this.runtimeInstanceId,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      threadId,
      ...(turnId !== undefined ? { turnId } : {}),
      event,
    };
    this.sequence += 1;
    for (const listener of this.listeners) {
      listener(envelope);
    }
  }

  private async driveTurn(state: ActiveTurnState, input: string): Promise<void> {
    const projection: TurnProjectionState = {
      streamId: undefined,
      text: "",
      terminalEmitted: false,
    };
    try {
      for await (const event of state.session.send(input)) {
        this.projectSessionEvent(state, projection, event);
      }
      if (!projection.terminalEmitted) {
        this.emit(state.threadId, state.turnId, { type: "turn.completed" });
      }
    } catch (error: unknown) {
      if (!projection.terminalEmitted) {
        this.emit(state.threadId, state.turnId, {
          type: "turn.failed",
          stage: "execute",
          message: redactSecretText(errorMessage(error)),
        });
      }
    } finally {
      if (this.activeTurns.get(state.threadId) === state) {
        this.activeTurns.delete(state.threadId);
      }
      this.settleTurnOwner(state);
      for (const [approvalId, pending] of this.pendingApprovals) {
        if (pending.approval.turnId === state.turnId) {
          this.pendingApprovals.delete(approvalId);
        }
      }
    }
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
        this.emit(state.threadId, state.turnId, { type: "turn.completed" });
        projection.terminalEmitted = true;
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
        });
        this.emit(state.threadId, state.turnId, {
          type: "approval.required",
          approval,
        });
        return;
      }
      case "turn-cancelled":
        this.emit(state.threadId, state.turnId, {
          type: "turn.cancelled",
          reason: event.reason,
          message: redactSecretText(event.message),
        });
        projection.terminalEmitted = true;
        break;
      case "error":
        this.emit(state.threadId, state.turnId, {
          type: "turn.failed",
          stage: event.stage,
          message: redactSecretText(event.message),
        });
        projection.terminalEmitted = true;
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
}
