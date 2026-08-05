import { randomUUID } from "node:crypto";
import {
  RUNTIME_ERROR_CODES,
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_SERVER_REQUEST_METHODS,
  RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES,
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORDS,
  RUNTIME_V13_RECOVERY_SNAPSHOT_METADATA_MAX_CHARS,
  clientCapabilitiesSetParamsSchema,
  getRuntimeProtocolCapabilities,
  getRuntimeProtocolRegistry,
  interactionIdSchema,
  isRuntimeMethodAvailable,
  normalizeUserInputResult,
  parseRuntimeMethodParamsForVersion,
  projectClientCapabilitiesSetResult,
  projectRuntimeEventEnvelopeForVersion,
  projectThreadSnapshotForVersion,
  runtimeMethodSchemas,
  runtimeDurableEventV13Schema,
  turnIdSchema,
  type ApprovalResolution,
  type ClientCapabilitiesSetResult,
  type LatestRuntimeMethod,
  type PendingInteractionProjection,
  type RuntimeEventEnvelopeV13,
  type RuntimeEventsResumeResult,
  type RuntimeProtocolVersion,
  type ThreadId,
  type ThreadSnapshotForVersion,
  type UserInputRequestParamsV12,
} from "@roll-agent/protocol";
import {
  RuntimeService,
  RuntimeServiceError,
  type RuntimeApprovalDecision,
  type RuntimeApprovalIdentity,
  type RuntimeThreadSnapshot,
  type RuntimeEventReplayBatch,
  type RuntimeUserInputInteractionEvent,
} from "../service/runtime-service.ts";
import {
  RuntimeClientRequestCancelledError,
  RuntimeClientRequestCoordinator,
  RuntimeClientRequestExpiredError,
  createRuntimeClientResponderId,
  getRuntimeClientRequestCoordinatorInternal,
  type RuntimeClientRequest,
  type RuntimeClientResponderId,
} from "./runtime-client-request-coordinator.ts";
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from "./protocol.ts";

const CLIENT_APPROVAL_FAILURE_REASON = "客户端未完成审批请求，Runtime 已终止当前 Turn";
const CLIENT_USER_INPUT_FAILURE_REASON = "客户端未完成用户输入请求";
const ACTIVE_RUNTIME_PROTOCOL_SERVICES = new WeakSet<RuntimeService>();
const MAX_REPLAY_LIVE_BUFFER_EVENTS = RUNTIME_V13_MAX_DURABLE_EVENT_RECORDS;
const MAX_REPLAY_LIVE_BUFFER_BYTES = RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES;

interface RuntimeEventReplayGate {
  readonly threadId: ThreadId;
  readonly buffered: RuntimeEventEnvelopeV13[];
  bufferedBytes: number;
}

export interface RuntimeProtocolDispatchResult {
  readonly result: unknown;
  readonly afterResponse?: (sent: boolean) => void;
}

function userInputInteractionKey(
  requestId: Extract<RuntimeUserInputInteractionEvent, { readonly type: "required" }>["requestId"],
): string {
  return `user-input:${requestId}`;
}

function approvalResolutionReason(resolution: ApprovalResolution): string {
  switch (resolution.status) {
    case "resolved":
      return resolution.decision === "approve" ? "审批已批准" : "审批已拒绝";
    case "cancelled":
      return resolution.reason;
    case "expired":
      return resolution.reason ?? "审批已到期";
  }
}

export class RuntimeProtocolAdapter {
  private readonly service: RuntimeService;
  private readonly connection: JsonRpcConnection;
  private readonly clientRequests: RuntimeClientRequestCoordinator;
  private readonly responderId: RuntimeClientResponderId;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeFatalError: () => void;
  private readonly unsubscribeUserInput: () => void;
  private readonly settlementTasks = new Set<Promise<void>>();
  private detachResponder: (() => void) | undefined;
  private initialized = false;
  private closing = false;
  private transportFailed = false;
  private controlsService = false;
  private protocolVersion: RuntimeProtocolVersion | undefined;
  private capabilityRevision: number | undefined;
  private capabilityMethods: readonly string[] | undefined;
  private capabilityResult: ClientCapabilitiesSetResult | undefined;
  private readonly replayGates = new Map<ThreadId, RuntimeEventReplayGate>();
  private eventSequence = 0;
  private closePromise: Promise<void> | undefined;

  constructor(
    service: RuntimeService,
    connection: JsonRpcConnection,
    clientRequests: RuntimeClientRequestCoordinator,
  ) {
    if (ACTIVE_RUNTIME_PROTOCOL_SERVICES.has(service)) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        "当前 RuntimeService 已绑定 Runtime Protocol Adapter",
      );
    }
    ACTIVE_RUNTIME_PROTOCOL_SERVICES.add(service);
    this.controlsService = true;
    this.service = service;
    this.connection = connection;
    this.clientRequests = clientRequests;
    this.responderId = createRuntimeClientResponderId();
    try {
      this.unsubscribe = service.onEvent((event) => this.handleServiceEvent(event));
    } catch (error: unknown) {
      this.releaseServiceControl();
      throw error;
    }
    try {
      this.unsubscribeUserInput = service.onUserInputInteraction((event) =>
        this.handleUserInputInteraction(event),
      );
    } catch (error: unknown) {
      this.unsubscribe();
      this.releaseServiceControl();
      throw error;
    }
    try {
      this.unsubscribeFatalError = service.onFatalError(() => this.closeBrokenTransport());
    } catch (error: unknown) {
      this.unsubscribeUserInput();
      this.unsubscribe();
      this.releaseServiceControl();
      throw error;
    }
  }

  private dispatchEventResume(request: JsonRpcRequest): RuntimeProtocolDispatchResult {
    if (!this.initialized) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.initializeRequired,
        "调用 Runtime Protocol 方法前必须先完成 initialize",
      );
    }
    if (this.protocolVersion !== "1.3") {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        `Runtime Protocol ${String(this.protocolVersion)} 不支持方法：${request.method}`,
      );
    }
    const params = runtimeMethodSchemas[RUNTIME_METHODS.runtimeEventsResume].params.parse(
      request.params,
    );
    if (this.replayGates.has(params.threadId)) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.threadBusy,
        `Thread "${params.threadId}" 已有进行中的 Runtime Event replay`,
        { retryable: true },
      );
    }
    const gate: RuntimeEventReplayGate = {
      threadId: params.threadId,
      buffered: [],
      bufferedBytes: 0,
    };
    this.replayGates.set(params.threadId, gate);
    try {
      const replay: RuntimeEventReplayBatch = this.service.resumeEvents(params);
      for (const stored of replay.events) {
        const replayEnvelope: RuntimeEventEnvelopeV13 = {
          protocolVersion: "1.3",
          runtimeInstanceId: this.service.runtimeInstanceId,
          sequence: this.eventSequence,
          timestamp: stored.timestamp,
          threadId: params.threadId,
          ...(stored.turnId === undefined ? {} : { turnId: turnIdSchema.parse(stored.turnId) }),
          durability: "durable",
          eventId: stored.eventId,
          cursor: stored.cursor,
          event: runtimeDurableEventV13Schema.parse(stored.event),
        };
        if (!this.sendEvent(replayEnvelope)) {
          throw new Error("Runtime Event replay transport write failed");
        }
      }
      const result: RuntimeEventsResumeResult = {
        throughCursor: replay.throughCursor,
        replayedCount: replay.replayedCount,
      };
      return {
        result,
        afterResponse: (sent) => {
          if (!sent) {
            this.releaseReplayGate(gate);
            return;
          }
          this.flushReplayGate(gate);
        },
      };
    } catch (error: unknown) {
      this.releaseReplayGate(gate);
      throw error;
    }
  }

  handles(method: string): method is LatestRuntimeMethod {
    return isRuntimeMethodAvailable("1.3", method);
  }

  handleResponse(message: JsonRpcMessage): boolean {
    if (
      this.protocolVersion === undefined ||
      !getRuntimeProtocolCapabilities(this.protocolVersion).serverRequests ||
      this.detachResponder === undefined
    ) {
      return false;
    }
    const attachmentResult = getRuntimeClientRequestCoordinatorInternal(
      this.clientRequests,
    ).handleResponseForAttachment(this.detachResponder, message);
    return attachmentResult ?? this.clientRequests.handleResponse(this.responderId, message);
  }

  async dispatch(request: JsonRpcRequest): Promise<RuntimeProtocolDispatchResult> {
    if (request.method === RUNTIME_METHODS.runtimeEventsResume) {
      return this.dispatchEventResume(request);
    }
    if (request.method === RUNTIME_METHODS.clientCapabilitiesSet) {
      return this.dispatchClientCapabilitiesSet(request);
    }
    return { result: await this.dispatchValue(request) };
  }

  private dispatchClientCapabilitiesSet(request: JsonRpcRequest): RuntimeProtocolDispatchResult {
    if (!this.initialized) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.initializeRequired,
        "调用 Runtime Protocol 方法前必须先完成 initialize",
      );
    }
    if (
      this.protocolVersion === undefined ||
      !getRuntimeProtocolCapabilities(this.protocolVersion).serverRequestCapabilityNegotiation
    ) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        `Runtime Protocol ${String(this.protocolVersion)} 不支持 capability negotiation：${request.method}`,
      );
    }
    return this.setClientCapabilities(clientCapabilitiesSetParamsSchema.parse(request.params));
  }

  private async dispatchValue(request: JsonRpcRequest): Promise<unknown> {
    if (!this.handles(request.method)) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        `未知 Runtime Protocol 方法：${request.method}`,
      );
    }
    if (request.method === RUNTIME_METHODS.initialize) {
      if (this.initialized) {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.capabilityUnavailable,
          "当前连接已完成 initialize，不能重新协商 Runtime Protocol",
        );
      }
      const params = runtimeMethodSchemas[RUNTIME_METHODS.initialize].params.parse(request.params);
      const result = this.service.initialize(params);
      this.protocolVersion = result.protocolVersion;
      if (getRuntimeProtocolCapabilities(result.protocolVersion).serverRequests) {
        const requiresCapabilityAck = getRuntimeProtocolCapabilities(
          result.protocolVersion,
        ).serverRequestCapabilityNegotiation;
        this.detachResponder = this.clientRequests.attachResponder(
          {
            id: this.responderId,
            scopeId: result.runtimeInstanceId,
            send: (message) => this.connection.send(message),
            close: () => this.connection.close(),
          },
          {
            acceptedServerRequestMethods: requiresCapabilityAck
              ? []
              : getRuntimeProtocolRegistry(result.protocolVersion).serverRequestMethods,
            capabilitiesAcknowledged: !requiresCapabilityAck,
          },
        );
        if (requiresCapabilityAck) {
          const internal = getRuntimeClientRequestCoordinatorInternal(this.clientRequests);
          const initialized =
            internal.beginCapabilityNegotiationForAttachment(this.detachResponder) ??
            this.clientRequests.beginResponderCapabilityNegotiation(this.responderId);
          if (!initialized) {
            throw new RuntimeServiceError(
              RUNTIME_ERROR_CODES.capabilityUnavailable,
              "Runtime 客户端 responder 无法进入 capability negotiation",
            );
          }
        }
      }
      this.initialized = true;
      return result;
    }
    if (!this.initialized) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.initializeRequired,
        "调用 Runtime Protocol 方法前必须先完成 initialize",
      );
    }
    if (
      this.protocolVersion === undefined ||
      !isRuntimeMethodAvailable(this.protocolVersion, request.method)
    ) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        `Runtime Protocol ${String(this.protocolVersion)} 不支持方法：${request.method}`,
      );
    }
    if (
      request.method === RUNTIME_METHODS.approvalRespond &&
      this.protocolVersion !== undefined &&
      !getRuntimeProtocolCapabilities(this.protocolVersion).clientApprovalResponses
    ) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        "当前协商协议的审批只能通过 approval.request 响应完成",
      );
    }

    switch (request.method) {
      case RUNTIME_METHODS.threadList:
        return this.service.listThreads(
          runtimeMethodSchemas[RUNTIME_METHODS.threadList].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadCreate:
        return this.service.createThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadCreate].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadOpen:
        return this.projectThreadSnapshot(
          await this.service.openThread(
            runtimeMethodSchemas[RUNTIME_METHODS.threadOpen].params.parse(request.params),
          ),
        );
      case RUNTIME_METHODS.threadSnapshot: {
        const params = parseRuntimeMethodParamsForVersion(
          this.protocolVersion,
          RUNTIME_METHODS.threadSnapshot,
          request.params,
        );
        const recoveryProjection =
          this.protocolVersion === "1.3" && "recovery" in params && params.recovery === true;
        return this.projectThreadSnapshot(
          this.service.snapshotThread({
            threadId: params.threadId,
            ...(params.messageBeforeSequence === undefined
              ? {}
              : { messageBeforeSequence: params.messageBeforeSequence }),
            ...(params.operationBeforeSequence === undefined
              ? {}
              : { operationBeforeSequence: params.operationBeforeSequence }),
            limit: params.limit,
          }),
          recoveryProjection,
        );
      }
      case RUNTIME_METHODS.threadRename:
        return this.service.renameThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadRename].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadDelete:
        return this.service.deleteThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadDelete].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadDetach:
        return this.service.detachThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadDetach].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadCapabilities:
        return this.service.threadCapabilities(
          runtimeMethodSchemas[RUNTIME_METHODS.threadCapabilities].params.parse(request.params),
        );
      case RUNTIME_METHODS.turnStart:
        return this.service.startTurn(
          runtimeMethodSchemas[RUNTIME_METHODS.turnStart].params.parse(request.params),
        );
      case RUNTIME_METHODS.turnCancel:
        return this.service.cancelTurn(
          runtimeMethodSchemas[RUNTIME_METHODS.turnCancel].params.parse(request.params),
        );
      case RUNTIME_METHODS.approvalRespond:
        return this.service.respondApproval(
          runtimeMethodSchemas[RUNTIME_METHODS.approvalRespond].params.parse(request.params),
        );
      case RUNTIME_METHODS.operationGet:
        return this.service.getOperation(
          runtimeMethodSchemas[RUNTIME_METHODS.operationGet].params.parse(request.params),
        );
      case RUNTIME_METHODS.runtimeEventsResume:
        throw new Error("runtime.events.resume requires the response-barrier dispatch path");
      case RUNTIME_METHODS.clientCapabilitiesSet:
        throw new Error("client.capabilities.set requires the response-barrier dispatch path");
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.performClose();
    await this.closePromise;
  }

  disposeConstructionFailure(): void {
    this.closing = true;
    this.unsubscribeFatalError();
    this.unsubscribe();
    this.unsubscribeUserInput();
    this.releaseServiceControl();
  }

  releaseServiceControl(): void {
    if (!this.controlsService) {
      return;
    }
    ACTIVE_RUNTIME_PROTOCOL_SERVICES.delete(this.service);
    this.controlsService = false;
  }

  private async performClose(): Promise<void> {
    this.closing = true;
    this.replayGates.clear();
    this.service.setUserInputAvailable(false);
    this.detachResponder?.();
    this.detachResponder = undefined;
    while (this.settlementTasks.size > 0) {
      await Promise.allSettled([...this.settlementTasks]);
    }
    this.unsubscribeFatalError();
    this.unsubscribe();
    this.unsubscribeUserInput();
  }

  private handleServiceEvent(envelope: RuntimeEventEnvelopeV13): void {
    if (!this.initialized || this.closing || this.protocolVersion === undefined) {
      return;
    }
    const replayGate = this.replayGates.get(envelope.threadId);
    if (replayGate !== undefined) {
      if (!this.bufferReplayLiveEvent(replayGate, envelope)) {
        this.closeBrokenTransport();
      }
      return;
    }
    this.deliverLiveEvent(envelope);
  }

  private deliverLiveEvent(envelope: RuntimeEventEnvelopeV13): boolean {
    if (!this.initialized || this.closing || this.protocolVersion === undefined) {
      return false;
    }
    const capabilities = getRuntimeProtocolCapabilities(this.protocolVersion);
    if (capabilities.serverRequests && envelope.event.type === "approval.resolved") {
      this.clientRequests.cancel(
        envelope.event.approvalId,
        approvalResolutionReason(envelope.event.resolution),
      );
    }
    if (capabilities.serverRequests && envelope.event.type === "approval.required") {
      this.requestApproval(envelope.threadId, envelope.event.approval);
    }
    return this.sendEvent(envelope);
  }

  private sendEvent(envelope: RuntimeEventEnvelopeV13): boolean {
    if (this.protocolVersion === undefined) {
      return false;
    }
    if (
      !getRuntimeProtocolCapabilities(this.protocolVersion).approvalResolvedEvents &&
      envelope.event.type === "approval.resolved"
    ) {
      return true;
    }
    const sequenced: RuntimeEventEnvelopeV13 = {
      ...envelope,
      sequence: Math.max(this.eventSequence, envelope.sequence),
    };
    this.eventSequence = sequenced.sequence + 1;
    const projected = projectRuntimeEventEnvelopeForVersion(this.protocolVersion, sequenced);
    try {
      this.connection.send({
        jsonrpc: "2.0",
        method: RUNTIME_EVENT_NOTIFICATION,
        params: projected,
      });
      return true;
    } catch {
      this.closeBrokenTransport();
      return false;
    }
  }

  private bufferReplayLiveEvent(
    gate: RuntimeEventReplayGate,
    envelope: RuntimeEventEnvelopeV13,
  ): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    if (
      gate.buffered.length >= MAX_REPLAY_LIVE_BUFFER_EVENTS ||
      gate.bufferedBytes + bytes > MAX_REPLAY_LIVE_BUFFER_BYTES
    ) {
      this.releaseReplayGate(gate);
      return false;
    }
    gate.buffered.push(envelope);
    gate.bufferedBytes += bytes;
    return true;
  }

  private flushReplayGate(gate: RuntimeEventReplayGate): void {
    if (this.replayGates.get(gate.threadId) !== gate) {
      return;
    }
    let index = 0;
    while (index < gate.buffered.length) {
      const envelope = gate.buffered[index];
      index += 1;
      if (envelope !== undefined && !this.deliverLiveEvent(envelope)) {
        this.releaseReplayGate(gate);
        return;
      }
    }
    this.releaseReplayGate(gate);
  }

  private releaseReplayGate(gate: RuntimeEventReplayGate): void {
    if (this.replayGates.get(gate.threadId) === gate) {
      this.replayGates.delete(gate.threadId);
    }
    gate.buffered.length = 0;
    gate.bufferedBytes = 0;
  }

  private closeBrokenTransport(): void {
    if (this.closing) {
      return;
    }
    this.transportFailed = true;
    this.closing = true;
    this.replayGates.clear();
    this.service.setUserInputAvailable(false);
    this.detachResponder?.();
    this.detachResponder = undefined;
    this.unsubscribeFatalError();
    this.unsubscribe();
    this.unsubscribeUserInput();
    try {
      this.connection.close();
    } catch {
      // The write already proved the transport unusable; local state is detached above.
    }
  }

  private projectThreadSnapshot(
    snapshot: RuntimeThreadSnapshot,
    recoveryProjection = false,
  ): ThreadSnapshotForVersion<RuntimeProtocolVersion> {
    const protocolVersion = this.protocolVersion;
    if (protocolVersion === undefined) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.initializeRequired,
        "投影 Thread Snapshot 前必须先完成 initialize",
      );
    }
    let pendingInteractions: readonly PendingInteractionProjection[] = [];
    if (
      !recoveryProjection &&
      getRuntimeProtocolCapabilities(protocolVersion).serverRequestCapabilityNegotiation
    ) {
      if (this.detachResponder === undefined) {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.capabilityUnavailable,
          "Runtime Protocol 1.2 responder 已失效",
        );
      }
      const projected = getRuntimeClientRequestCoordinatorInternal(
        this.clientRequests,
      ).getPendingInteractionProjectionsForAttachment(this.detachResponder, snapshot.thread.id);
      const responderProjection =
        projected ??
        this.clientRequests.getPendingInteractionProjections(this.responderId, snapshot.thread.id);
      if (responderProjection === undefined) {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.capabilityUnavailable,
          "Runtime Protocol 1.2 responder attachment 已失效",
        );
      }
      pendingInteractions = responderProjection;
    }
    if (recoveryProjection) {
      const clipMetadata = (value: string | undefined): string | undefined =>
        value?.slice(0, RUNTIME_V13_RECOVERY_SNAPSHOT_METADATA_MAX_CHARS);
      const title = clipMetadata(snapshot.thread.title);
      const model = clipMetadata(snapshot.thread.model);
      return projectThreadSnapshotForVersion(protocolVersion, {
        ...snapshot,
        thread: {
          ...snapshot.thread,
          ...(title === undefined ? {} : { title }),
          ...(model === undefined ? {} : { model }),
        },
        messages: { items: [], nextBeforeSequence: null },
        operations: { items: [], nextBeforeSequence: null },
        pendingApprovals: [],
        pendingInteractions: [],
        recoveryProjection: true,
      });
    }
    return projectThreadSnapshotForVersion(protocolVersion, { ...snapshot, pendingInteractions });
  }

  private handleUserInputInteraction(event: RuntimeUserInputInteractionEvent): void {
    if (event.type === "settled") {
      this.clientRequests.cancel(userInputInteractionKey(event.requestId), event.reason);
      return;
    }
    if (
      this.closing ||
      !this.initialized ||
      this.protocolVersion === undefined ||
      !getRuntimeProtocolCapabilities(this.protocolVersion).serverRequestCapabilityNegotiation
    ) {
      this.service.cancelPendingUserInput(event.requestId, CLIENT_USER_INPUT_FAILURE_REASON);
      return;
    }
    this.requestUserInput(event);
  }

  private requestUserInput(
    interaction: Extract<RuntimeUserInputInteractionEvent, { readonly type: "required" }>,
  ): void {
    const protocolVersion = this.protocolVersion;
    if (
      protocolVersion === undefined ||
      !getRuntimeProtocolCapabilities(protocolVersion).serverRequestCapabilityNegotiation
    ) {
      this.service.cancelPendingUserInput(interaction.requestId, CLIENT_USER_INPUT_FAILURE_REASON);
      return;
    }
    const params: UserInputRequestParamsV12 = {
      interactionId: interactionIdSchema.parse(randomUUID()),
      threadId: interaction.threadId,
      turnId: interaction.turnId,
      expiresAt: interaction.expiresAt,
      sensitivity: "normal",
      ...interaction.form,
    };
    let request: RuntimeClientRequest<typeof RUNTIME_SERVER_REQUEST_METHODS.userInputRequest>;
    try {
      request = this.clientRequests.request(
        RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
        params,
        {
          key: userInputInteractionKey(interaction.requestId),
          scopeId: this.service.runtimeInstanceId,
          eligibleResponderId: this.responderId,
          threadId: interaction.threadId,
          turnId: interaction.turnId,
          protocolVersion,
          expiresAt: interaction.expiresAt,
        },
      );
    } catch {
      this.service.cancelPendingUserInput(interaction.requestId, CLIENT_USER_INPUT_FAILURE_REASON);
      return;
    }
    const task = request.result.then(
      (candidate) => {
        try {
          const normalized = normalizeUserInputResult(params, candidate);
          this.service.resolvePendingUserInput(interaction.requestId, normalized);
        } catch {
          this.service.cancelPendingUserInput(
            interaction.requestId,
            "客户端返回的用户输入不符合原始表单约束",
          );
        }
      },
      (error: unknown) => {
        const reason =
          error instanceof RuntimeClientRequestExpiredError
            ? "用户输入请求已超时"
            : error instanceof RuntimeClientRequestCancelledError
              ? error.reason
              : CLIENT_USER_INPUT_FAILURE_REASON;
        this.service.cancelPendingUserInput(interaction.requestId, reason);
      },
    );
    this.trackSettlement(task);
  }

  private requestApproval(
    threadId: RuntimeApprovalIdentity["threadId"],
    approval: Extract<
      RuntimeEventEnvelopeV13["event"],
      { readonly type: "approval.required" }
    >["approval"],
  ): void {
    const identity: RuntimeApprovalIdentity = {
      threadId,
      turnId: approval.turnId,
      approvalId: approval.id,
    };
    let request:
      | RuntimeClientRequest<typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest>
      | undefined;
    try {
      const protocolVersion = this.protocolVersion;
      if (protocolVersion === undefined || protocolVersion === "1.0") {
        throw new RuntimeClientRequestCancelledError("当前协议不支持 Server Request");
      }
      const expiresAt = this.service.getPendingApprovalExpiresAt(identity);
      const usesInteractionMetadata =
        getRuntimeProtocolCapabilities(protocolVersion).serverRequestCapabilityNegotiation;
      const interactionExpiresAt = usesInteractionMetadata
        ? (() => {
            if (expiresAt === undefined) {
              throw new RuntimeClientRequestCancelledError(
                "Runtime Protocol 1.2 审批请求缺少绝对 expiresAt deadline",
              );
            }
            return expiresAt;
          })()
        : undefined;
      const params = usesInteractionMetadata
        ? {
            interactionId: interactionIdSchema.parse(randomUUID()),
            threadId,
            turnId: approval.turnId,
            expiresAt: interactionExpiresAt,
            sensitivity: "normal" as const,
            approval,
          }
        : {
            threadId,
            approval,
          };
      request = this.clientRequests.request(
        RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
        params,
        {
          key: approval.id,
          scopeId: this.service.runtimeInstanceId,
          eligibleResponderId: this.responderId,
          approvalId: approval.id,
          threadId,
          turnId: approval.turnId,
          protocolVersion,
          ...(interactionExpiresAt === undefined ? {} : { expiresAt: interactionExpiresAt }),
        },
      );
    } catch {
      const task = Promise.resolve()
        .then(() =>
          this.service.failPendingApprovalInteraction(identity, CLIENT_APPROVAL_FAILURE_REASON),
        )
        .then(() => undefined);
      this.trackSettlement(task);
      return;
    }
    const task = request.result.then(
      async (result) => {
        const decision: RuntimeApprovalDecision =
          result.decision === "approve"
            ? { decision: "approve" }
            : {
                decision: "reject",
                ...(result.reason !== undefined ? { reason: result.reason } : {}),
              };
        try {
          this.service.resolvePendingApproval(identity, decision);
        } catch (error: unknown) {
          if (
            !(error instanceof RuntimeServiceError) ||
            error.rollCode !== RUNTIME_ERROR_CODES.approvalNotFound
          ) {
            await this.service.failPendingApprovalInteraction(
              identity,
              CLIENT_APPROVAL_FAILURE_REASON,
            );
          }
        }
      },
      async (error: unknown) => {
        if (this.closing && !this.transportFailed) {
          return;
        }
        if (error instanceof RuntimeClientRequestExpiredError) {
          await this.service.failPendingApprovalInteraction(identity, "审批请求已到期", {
            status: "expired",
            reason: "审批请求已到期",
          });
          return;
        }
        const reason =
          error instanceof RuntimeClientRequestCancelledError
            ? error.reason
            : CLIENT_APPROVAL_FAILURE_REASON;
        await this.service.failPendingApprovalInteraction(identity, reason);
      },
    );
    this.trackSettlement(task);
  }

  private setClientCapabilities(
    params: ReturnType<typeof clientCapabilitiesSetParamsSchema.parse>,
  ): RuntimeProtocolDispatchResult {
    if (
      this.protocolVersion === undefined ||
      !getRuntimeProtocolCapabilities(this.protocolVersion).serverRequestCapabilityNegotiation ||
      this.detachResponder === undefined
    ) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        "client.capabilities.set 仅可用于支持 capability negotiation 的 Runtime Protocol",
      );
    }
    const canonicalMethods = [...params.serverRequestMethods].sort();
    if (this.capabilityRevision !== undefined) {
      const isSameRevision = params.revision === this.capabilityRevision;
      const isSameMethods =
        canonicalMethods.length === this.capabilityMethods?.length &&
        canonicalMethods.every((method, index) => method === this.capabilityMethods?.[index]);
      if (isSameRevision && isSameMethods && this.capabilityResult !== undefined) {
        return { result: this.capabilityResult };
      }
      if (params.revision <= this.capabilityRevision) {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.capabilityRevisionConflict,
          `Capability revision ${String(params.revision)} 与当前 revision ${String(
            this.capabilityRevision,
          )} 冲突`,
        );
      }
    }
    const result = projectClientCapabilitiesSetResult(params);
    const reason = `Runtime 客户端已在 capability revision ${String(params.revision)} 撤销处理能力`;
    const internal = getRuntimeClientRequestCoordinatorInternal(this.clientRequests);
    const commit =
      internal.setServerRequestMethodsForAttachment(
        this.detachResponder,
        result.acceptedServerRequestMethods,
        reason,
      ) ??
      this.clientRequests.setResponderServerRequestMethods(
        this.responderId,
        result.acceptedServerRequestMethods,
        reason,
      );
    if (commit === false) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        "Runtime 客户端 responder 已失效",
      );
    }
    this.service.setUserInputAvailable(
      result.acceptedServerRequestMethods.includes(RUNTIME_SERVER_REQUEST_METHODS.userInputRequest),
    );
    this.capabilityRevision = params.revision;
    this.capabilityMethods = canonicalMethods;
    this.capabilityResult = result;
    return {
      result,
      afterResponse: (sent) => {
        if (sent) {
          commit();
        }
      },
    };
  }

  private trackSettlement(task: Promise<void>): void {
    this.settlementTasks.add(task);
    task.finally(() => this.settlementTasks.delete(task)).catch(() => undefined);
  }
}
