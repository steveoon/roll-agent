import { randomUUID } from "node:crypto";
import {
  RUNTIME_ERROR_CODES,
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_SERVER_REQUEST_METHODS,
  clientCapabilitiesSetParamsSchema,
  getRuntimeProtocolCapabilities,
  getRuntimeProtocolRegistry,
  interactionIdSchema,
  isRuntimeMethodAvailable,
  normalizeUserInputResult,
  projectClientCapabilitiesSetResult,
  projectThreadSnapshotForVersion,
  runtimeMethodSchemas,
  type ApprovalResolution,
  type ClientCapabilitiesSetResult,
  type LatestRuntimeMethod,
  type PendingInteractionProjection,
  type RuntimeEventEnvelope,
  type RuntimeProtocolVersion,
  type ThreadSnapshotForVersion,
  type UserInputRequestParamsV12,
} from "@roll-agent/protocol";
import {
  RuntimeService,
  RuntimeServiceError,
  type RuntimeApprovalDecision,
  type RuntimeApprovalIdentity,
  type RuntimeThreadSnapshot,
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
  }

  handles(method: string): method is LatestRuntimeMethod {
    return isRuntimeMethodAvailable("1.2", method);
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

  async dispatch(request: JsonRpcRequest): Promise<unknown> {
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
    if (request.method === RUNTIME_METHODS.clientCapabilitiesSet) {
      if (this.protocolVersion !== "1.2") {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.capabilityUnavailable,
          `Runtime Protocol ${String(this.protocolVersion)} 不支持方法：${request.method}`,
        );
      }
      return this.setClientCapabilities(clientCapabilitiesSetParamsSchema.parse(request.params));
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
      case RUNTIME_METHODS.threadSnapshot:
        return this.projectThreadSnapshot(
          this.service.snapshotThread(
            runtimeMethodSchemas[RUNTIME_METHODS.threadSnapshot].params.parse(request.params),
          ),
        );
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
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.performClose();
    await this.closePromise;
  }

  disposeConstructionFailure(): void {
    this.closing = true;
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
    this.service.setUserInputAvailable(false);
    this.detachResponder?.();
    this.detachResponder = undefined;
    while (this.settlementTasks.size > 0) {
      await Promise.allSettled([...this.settlementTasks]);
    }
    this.unsubscribe();
    this.unsubscribeUserInput();
  }

  private handleServiceEvent(envelope: RuntimeEventEnvelope): void {
    if (!this.initialized || this.closing || this.protocolVersion === undefined) {
      return;
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
    this.sendEvent(envelope);
  }

  private sendEvent(envelope: RuntimeEventEnvelope): void {
    if (this.protocolVersion === undefined) {
      return;
    }
    if (
      !getRuntimeProtocolCapabilities(this.protocolVersion).approvalResolvedEvents &&
      envelope.event.type === "approval.resolved"
    ) {
      return;
    }
    const projected: RuntimeEventEnvelope = {
      ...envelope,
      protocolVersion: this.protocolVersion,
      sequence: Math.max(this.eventSequence, envelope.sequence),
    };
    this.eventSequence = projected.sequence + 1;
    try {
      this.connection.send({
        jsonrpc: "2.0",
        method: RUNTIME_EVENT_NOTIFICATION,
        params: projected,
      });
    } catch {
      this.closeBrokenTransport();
    }
  }

  private closeBrokenTransport(): void {
    if (this.closing) {
      return;
    }
    this.transportFailed = true;
    this.closing = true;
    this.service.setUserInputAvailable(false);
    this.detachResponder?.();
    this.detachResponder = undefined;
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
  ): ThreadSnapshotForVersion<RuntimeProtocolVersion> {
    const protocolVersion = this.protocolVersion;
    if (protocolVersion === undefined) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.initializeRequired,
        "投影 Thread Snapshot 前必须先完成 initialize",
      );
    }
    let pendingInteractions: readonly PendingInteractionProjection[] = [];
    if (protocolVersion === "1.2") {
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
    return projectThreadSnapshotForVersion(protocolVersion, {
      ...snapshot,
      pendingInteractions,
    });
  }

  private handleUserInputInteraction(event: RuntimeUserInputInteractionEvent): void {
    if (event.type === "settled") {
      this.clientRequests.cancel(userInputInteractionKey(event.requestId), event.reason);
      return;
    }
    if (this.closing || !this.initialized || this.protocolVersion !== "1.2") {
      this.service.cancelPendingUserInput(event.requestId, CLIENT_USER_INPUT_FAILURE_REASON);
      return;
    }
    this.requestUserInput(event);
  }

  private requestUserInput(
    interaction: Extract<RuntimeUserInputInteractionEvent, { readonly type: "required" }>,
  ): void {
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
          protocolVersion: "1.2",
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
      RuntimeEventEnvelope["event"],
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
      const interactionExpiresAt =
        protocolVersion === "1.2"
          ? (() => {
              if (expiresAt === undefined) {
                throw new RuntimeClientRequestCancelledError(
                  "Runtime Protocol 1.2 审批请求缺少绝对 expiresAt deadline",
                );
              }
              return expiresAt;
            })()
          : undefined;
      const params =
        protocolVersion === "1.2"
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
  ): ClientCapabilitiesSetResult {
    if (this.protocolVersion !== "1.2" || this.detachResponder === undefined) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        "client.capabilities.set 仅可用于 Runtime Protocol 1.2",
      );
    }
    const canonicalMethods = [...params.serverRequestMethods].sort();
    if (this.capabilityRevision !== undefined) {
      const isSameRevision = params.revision === this.capabilityRevision;
      const isSameMethods =
        canonicalMethods.length === this.capabilityMethods?.length &&
        canonicalMethods.every((method, index) => method === this.capabilityMethods?.[index]);
      if (isSameRevision && isSameMethods && this.capabilityResult !== undefined) {
        return this.capabilityResult;
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
    const updated =
      internal.setServerRequestMethodsForAttachment(
        this.detachResponder,
        result.acceptedServerRequestMethods,
        reason,
        true,
      ) ??
      this.clientRequests.setResponderServerRequestMethods(
        this.responderId,
        result.acceptedServerRequestMethods,
        reason,
        true,
      );
    if (!updated) {
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
    return result;
  }

  private trackSettlement(task: Promise<void>): void {
    this.settlementTasks.add(task);
    task.finally(() => this.settlementTasks.delete(task)).catch(() => undefined);
  }
}
