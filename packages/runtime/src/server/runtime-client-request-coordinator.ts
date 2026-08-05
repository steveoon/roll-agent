import { randomUUID } from "node:crypto";
import {
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  RUNTIME_SERVER_REQUEST_METHODS,
  approvalRequestParamsV12Schema,
  getRuntimeProtocolCapabilities,
  getRuntimeProtocolRegistry,
  interactionIdSchema,
  isRuntimeServerRequestMethodAvailable,
  pendingInteractionProjectionSchema,
  projectRuntimeServerRequestCancelParams,
  timestampSchema,
  userInputRequestParamsV12Schema,
  type ApprovalId,
  type PendingInteractionProjection,
  type RuntimeInstanceId,
  type RuntimeProtocolRegistry,
  type RuntimeServerRequestMethod,
  type RuntimeServerRequestResultForSupportedVersions,
  type RuntimeProtocolVersion,
  type ThreadId,
  type TurnId,
} from "@roll-agent/protocol";
import {
  RuntimeClientInteractionLifecycle,
  type RuntimeClientDelivery,
  type RuntimeClientInteraction,
} from "./runtime-client-interaction-lifecycle.ts";
import type { JsonRpcMessage } from "./protocol.ts";

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;
const DEFAULT_CANCELLATION_REASON = "Runtime 请求已取消";

declare const runtimeClientResponderIdBrand: unique symbol;

export type RuntimeClientResponderId = string & {
  readonly [runtimeClientResponderIdBrand]: "RuntimeClientResponderId";
};

export function createRuntimeClientResponderId(): RuntimeClientResponderId {
  return `runtime-client:${randomUUID()}` as RuntimeClientResponderId;
}

export interface RuntimeClientResponder {
  readonly id: RuntimeClientResponderId;
  readonly scopeId: RuntimeInstanceId;
  send(message: JsonRpcMessage): void;
  close(): void;
}

export interface RuntimeClientRequestCoordinatorOptions {
  readonly now?: () => number;
  readonly onDiagnostic?: (message: string) => void;
}

interface RuntimeClientResponderAttachment {
  readonly responder: RuntimeClientResponder;
  acceptedServerRequestMethods: ReadonlySet<RuntimeServerRequestMethod>;
  capabilitiesAcknowledged: boolean;
}

type ManagedRuntimeClientInteraction = RuntimeClientInteraction<
  RuntimeClientResponderId,
  RuntimeClientResponderAttachment
>;
type ManagedRuntimeClientDelivery = RuntimeClientDelivery<RuntimeClientResponderAttachment>;

export interface RuntimeClientRequestOptions {
  readonly key: string;
  readonly scopeId: RuntimeInstanceId;
  readonly eligibleResponderId: RuntimeClientResponderId;
  readonly approvalId?: ApprovalId;
  /** @deprecated Thread identity is carried by the validated request params. */
  readonly threadId?: ThreadId;
  /** @deprecated Turn identity is carried by the validated request params. */
  readonly turnId?: TurnId;
  readonly expiresAt?: string;
  /** Defaults to Protocol 1.1 for compatibility with existing package-internal callers. */
  readonly protocolVersion?: RuntimeProtocolVersion;
}

export interface RuntimeClientResponderOptions {
  /** Defaults to the frozen Protocol 1.1 Server Request registry. */
  readonly acceptedServerRequestMethods?: readonly RuntimeServerRequestMethod[];
  /** Protocol 1.3/1.2 responders start false and become eligible only after capability ACK. */
  readonly capabilitiesAcknowledged?: boolean;
}

export interface RuntimeClientRequest<TMethod extends RuntimeServerRequestMethod> {
  readonly key: string;
  readonly result: Promise<RuntimeServerRequestResultForSupportedVersions<TMethod>>;
}

export interface RuntimeClientRequestCoordinatorInternal {
  handleResponseForAttachment(
    detachResponder: () => void,
    message: JsonRpcMessage,
  ): boolean | undefined;
  setServerRequestMethodsForAttachment(
    detachResponder: () => void,
    methods: readonly RuntimeServerRequestMethod[],
    reason: string,
  ): (() => void) | false | undefined;
  setServerRequestMethodsForResponder(
    responderId: RuntimeClientResponderId,
    methods: readonly RuntimeServerRequestMethod[],
    reason: string,
  ): (() => void) | false;
  beginCapabilityNegotiationForAttachment(detachResponder: () => void): boolean | undefined;
  getPendingInteractionProjectionsForAttachment(
    detachResponder: () => void,
    threadId: ThreadId,
  ): readonly PendingInteractionProjection[] | undefined;
  redeliver(key: string, responderId: RuntimeClientResponderId): boolean;
}

const runtimeClientRequestCoordinatorInternals = new WeakMap<
  RuntimeClientRequestCoordinator,
  RuntimeClientRequestCoordinatorInternal
>();

export class RuntimeClientRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeClientRequestError";
  }
}

export class RuntimeClientRequestCancelledError extends RuntimeClientRequestError {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "RuntimeClientRequestCancelledError";
    this.reason = reason;
  }
}

export class RuntimeClientRequestExpiredError extends RuntimeClientRequestError {
  readonly expiresAt: string;

  constructor(expiresAt: string) {
    super(`Runtime 请求已于 ${expiresAt} 到期`);
    this.name = "RuntimeClientRequestExpiredError";
    this.expiresAt = expiresAt;
  }
}

/**
 * Owns Runtime→Client requests for the active local transport connection.
 *
 * Each request receives a JSON-RPC id and is accepted only from the responder and Runtime scope
 * selected for that delivery. Disconnecting the responder cancels its outstanding requests.
 */
export class RuntimeClientRequestCoordinator {
  private readonly now: () => number;
  private readonly onDiagnostic: ((message: string) => void) | undefined;
  private readonly responders = new Map<
    RuntimeClientResponderId,
    RuntimeClientResponderAttachment
  >();
  private readonly responderAttachments = new WeakMap<
    () => void,
    RuntimeClientResponderAttachment
  >();
  private readonly interactions = new RuntimeClientInteractionLifecycle<
    RuntimeClientResponderId,
    RuntimeClientResponderAttachment
  >();

  constructor(options: RuntimeClientRequestCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onDiagnostic = options.onDiagnostic;
    runtimeClientRequestCoordinatorInternals.set(this, {
      handleResponseForAttachment: (detachResponder, message) => {
        const attachment = this.responderAttachments.get(detachResponder);
        return attachment === undefined
          ? undefined
          : this.handleResponseFromAttachment(attachment, message);
      },
      setServerRequestMethodsForAttachment: (detachResponder, methods, reason) => {
        const attachment = this.responderAttachments.get(detachResponder);
        return attachment === undefined
          ? undefined
          : this.setServerRequestMethodsForAttachment(attachment, methods, reason);
      },
      setServerRequestMethodsForResponder: (responderId, methods, reason) => {
        const attachment = this.responders.get(responderId);
        return attachment === undefined
          ? false
          : this.setServerRequestMethodsForAttachment(attachment, methods, reason);
      },
      beginCapabilityNegotiationForAttachment: (detachResponder) => {
        const attachment = this.responderAttachments.get(detachResponder);
        return attachment === undefined
          ? undefined
          : this.beginCapabilityNegotiationForAttachment(attachment);
      },
      getPendingInteractionProjectionsForAttachment: (detachResponder, threadId) => {
        const attachment = this.responderAttachments.get(detachResponder);
        return attachment === undefined
          ? undefined
          : this.getPendingInteractionProjectionsForAttachment(attachment, threadId);
      },
      redeliver: (key, responderId) => this.redeliver(key, responderId),
    });
  }

  attachResponder(
    responder: RuntimeClientResponder,
    options: RuntimeClientResponderOptions = {},
  ): () => void {
    if (this.responders.has(responder.id)) {
      throw new RuntimeClientRequestError(`Runtime responder "${responder.id}" 已连接`);
    }
    const acceptedServerRequestMethods = new Set(
      options.acceptedServerRequestMethods ??
        getRuntimeProtocolRegistry("1.1").serverRequestMethods,
    );
    const attachment: RuntimeClientResponderAttachment = {
      responder,
      acceptedServerRequestMethods,
      capabilitiesAcknowledged: options.capabilitiesAcknowledged ?? true,
    };
    this.responders.set(responder.id, attachment);
    const detachResponder = () => {
      this.detachResponder(attachment, "Runtime 客户端连接已关闭");
    };
    this.responderAttachments.set(detachResponder, attachment);
    return detachResponder;
  }

  request<TMethod extends RuntimeServerRequestMethod>(
    method: TMethod,
    params: unknown,
    options: RuntimeClientRequestOptions,
  ): RuntimeClientRequest<TMethod> {
    if (this.interactions.has(options.key)) {
      throw new RuntimeClientRequestError(`Runtime 请求 "${options.key}" 已存在`);
    }
    const protocolVersion = options.protocolVersion ?? "1.1";
    if (!isRuntimeServerRequestMethodAvailable(protocolVersion, method)) {
      throw new RuntimeClientRequestError(
        `Runtime Protocol ${protocolVersion} 不支持 Server Request "${method}"`,
      );
    }
    const registry: RuntimeProtocolRegistry = getRuntimeProtocolRegistry(protocolVersion);
    const requestDefinition = registry.serverRequests[method];
    if (requestDefinition === undefined) {
      throw new RuntimeClientRequestError(
        `Runtime Protocol ${protocolVersion} 缺少 Server Request "${method}" schema`,
      );
    }
    const parsedParams = requestDefinition.params.parse(params);
    const usesInteractionMetadata =
      getRuntimeProtocolCapabilities(protocolVersion).serverRequestCapabilityNegotiation;
    if (
      usesInteractionMetadata &&
      (options.expiresAt === undefined ||
        typeof parsedParams !== "object" ||
        parsedParams === null ||
        !("expiresAt" in parsedParams) ||
        parsedParams.expiresAt !== options.expiresAt)
    ) {
      throw new RuntimeClientRequestError(
        `Runtime Protocol ${protocolVersion} 请求必须提供一致的绝对 expiresAt deadline`,
      );
    }
    const interactionId = usesInteractionMetadata
      ? interactionIdSchema.parse(
          typeof parsedParams === "object" &&
            parsedParams !== null &&
            "interactionId" in parsedParams
            ? parsedParams.interactionId
            : undefined,
        )
      : interactionIdSchema.parse(randomUUID());
    let expiresAt: string | undefined;
    if (options.expiresAt !== undefined) {
      const parsedExpiresAt = timestampSchema.safeParse(options.expiresAt);
      if (!parsedExpiresAt.success || !Number.isFinite(Date.parse(parsedExpiresAt.data))) {
        throw new RuntimeClientRequestError("Runtime 请求 expiresAt 必须是有效的 ISO 8601 时间戳");
      }
      expiresAt = parsedExpiresAt.data;
    }
    const deferred =
      Promise.withResolvers<RuntimeServerRequestResultForSupportedVersions<TMethod>>();
    const interaction = this.interactions.register({
      key: options.key,
      method,
      params: parsedParams,
      scopeId: options.scopeId,
      eligibleResponderId: options.eligibleResponderId,
      protocolVersion,
      interactionId,
      legacyApprovalId: options.approvalId,
      expiresAt,
      reject: deferred.reject,
      resolveResponse: (value) => {
        try {
          deferred.resolve(
            requestDefinition.result.parse(
              value,
            ) as RuntimeServerRequestResultForSupportedVersions<TMethod>,
          );
        } catch (error: unknown) {
          deferred.reject(
            new RuntimeClientRequestError(
              error instanceof Error
                ? `客户端返回了无效的 Runtime 请求结果：${error.message}`
                : "客户端返回了无效的 Runtime 请求结果",
            ),
          );
        }
      },
    });
    this.scheduleExpiration(interaction);
    if (this.interactions.get(interaction.key) === interaction) {
      this.deliver(interaction);
    }
    return {
      key: interaction.key,
      result: deferred.promise,
    };
  }

  handleResponse(responderId: RuntimeClientResponderId, message: JsonRpcMessage): boolean {
    const attachment = this.responders.get(responderId);
    if (attachment === undefined) {
      if ("method" in message || !("id" in message)) {
        return false;
      }
      if (message.id === null) {
        return true;
      }
      const correlated = this.interactions.getByDeliveryId(message.id);
      if (correlated === undefined) {
        return false;
      }
      this.diagnose(
        '忽略来自非目标 responder "' + responderId + '" 的 Runtime 响应 ' + String(message.id),
      );
      return true;
    }
    return this.handleResponseFromAttachment(attachment, message);
  }

  private handleResponseFromAttachment(
    attachment: RuntimeClientResponderAttachment,
    message: JsonRpcMessage,
  ): boolean {
    if ("method" in message || !("id" in message)) {
      return false;
    }
    const { responder } = attachment;
    const responderId = responder.id;
    if (this.responders.get(responderId) !== attachment) {
      this.diagnose('忽略来自已失效 responder session "' + responderId + '" 的 Runtime 响应');
      return false;
    }
    if (message.id === null) {
      const detail =
        "error" in message
          ? `${message.error.code} ${message.error.message}`
          : "客户端返回了非法的 id:null 成功响应";
      this.responders.delete(responderId);
      this.failAttachment(
        attachment,
        new RuntimeClientRequestError(`客户端返回无法关联的 JSON-RPC 错误：${detail}`),
      );
      try {
        responder.close();
      } catch {
        // Correlated requests were already failed closed.
      }
      return true;
    }
    const correlated = this.interactions.getByDeliveryId(message.id);
    if (correlated === undefined) {
      return false;
    }
    const { interaction, delivery } = correlated;
    if (delivery.attachment !== attachment) {
      this.diagnose(
        `忽略来自非目标 responder "${responderId}" 的 Runtime 响应 ${String(message.id)}`,
      );
      return true;
    }
    if (responder.scopeId !== interaction.scopeId) {
      this.diagnose(`忽略 Runtime scope 不匹配的响应 ${String(message.id)} (${interaction.key})`);
      return true;
    }
    if (this.isExpired(interaction)) {
      this.expire(interaction);
      return true;
    }
    if ("error" in message) {
      this.rejectInteraction(
        interaction,
        new RuntimeClientRequestError(
          `客户端未完成 Runtime 请求：${message.error.code} ${message.error.message}`,
        ),
      );
    } else {
      const settlement = this.interactions.settle(interaction, { kind: "response" });
      if (settlement.settled) {
        interaction.resolveResponse(message.result);
      }
    }
    return true;
  }

  cancel(key: string, reason: string): boolean {
    const interaction = this.interactions.get(key);
    if (interaction === undefined) {
      return false;
    }
    const cancellationReason =
      typeof reason === "string" && reason.length > 0 ? reason : DEFAULT_CANCELLATION_REASON;
    const settlement = this.interactions.settle(interaction, {
      kind: "cancelled",
      reason: cancellationReason,
    });
    if (!settlement.settled) {
      return false;
    }
    this.sendCancellation(interaction, settlement.retiredDelivery, cancellationReason);
    interaction.reject(new RuntimeClientRequestCancelledError(cancellationReason));
    return true;
  }

  cancelAll(reason: string): void {
    for (const interaction of this.interactions.pending()) {
      this.cancel(interaction.key, reason);
    }
  }

  setResponderServerRequestMethods(
    responderId: RuntimeClientResponderId,
    methods: readonly RuntimeServerRequestMethod[],
    reason: string,
    deferDelivery = false,
  ): boolean {
    const attachment = this.responders.get(responderId);
    if (attachment === undefined) {
      return false;
    }
    const commit = this.setServerRequestMethodsForAttachment(attachment, methods, reason);
    if (commit === false) {
      return false;
    }
    if (deferDelivery) {
      setTimeout(commit, 0);
    } else {
      commit();
    }
    return true;
  }

  beginResponderCapabilityNegotiation(responderId: RuntimeClientResponderId): boolean {
    const attachment = this.responders.get(responderId);
    return attachment === undefined
      ? false
      : this.beginCapabilityNegotiationForAttachment(attachment);
  }

  getPendingInteractionProjections(
    responderId: RuntimeClientResponderId,
    threadId: ThreadId,
  ): readonly PendingInteractionProjection[] | undefined {
    const attachment = this.responders.get(responderId);
    return attachment === undefined
      ? undefined
      : this.getPendingInteractionProjectionsForAttachment(attachment, threadId);
  }

  private detachResponder(attachment: RuntimeClientResponderAttachment, reason: string): void {
    const { responder } = attachment;
    if (this.responders.get(responder.id) !== attachment) {
      return;
    }
    this.responders.delete(responder.id);
    for (const interaction of this.interactions.pending()) {
      if (interaction.eligibleResponderId !== responder.id) {
        continue;
      }
      const settlement = this.interactions.settle(interaction, { kind: "cancelled", reason });
      if (settlement.settled) {
        this.sendCancellation(interaction, settlement.retiredDelivery, reason);
        interaction.reject(new RuntimeClientRequestCancelledError(reason));
      }
    }
  }

  private deliver(interaction: ManagedRuntimeClientInteraction): void {
    if (this.isExpired(interaction)) {
      this.expire(interaction);
      return;
    }
    const attachment = this.responders.get(interaction.eligibleResponderId);
    if (attachment === undefined || attachment.responder.scopeId !== interaction.scopeId) {
      this.rejectInteraction(
        interaction,
        new RuntimeClientRequestError("没有可处理 Runtime 请求的目标客户端"),
      );
      return;
    }
    if (!attachment.capabilitiesAcknowledged) {
      return;
    }
    if (!attachment.acceptedServerRequestMethods.has(interaction.method)) {
      this.rejectInteraction(
        interaction,
        new RuntimeClientRequestError(
          `目标客户端未协商 Runtime Server Request "${interaction.method}"`,
        ),
      );
      return;
    }
    const delivery = this.interactions.beginDelivery(interaction, attachment);
    if (delivery !== undefined) {
      this.sendDelivery(interaction, delivery);
    }
  }

  private sendDelivery(
    interaction: ManagedRuntimeClientInteraction,
    delivery: ManagedRuntimeClientDelivery,
  ): void {
    try {
      delivery.attachment.responder.send({
        jsonrpc: "2.0",
        id: delivery.id,
        method: interaction.method,
        params: interaction.params,
      });
    } catch (error: unknown) {
      this.rejectInteraction(
        interaction,
        new RuntimeClientRequestError(
          error instanceof Error
            ? `Runtime 请求发送失败：${error.message}`
            : "Runtime 请求发送失败",
        ),
      );
    }
  }

  private scheduleExpiration(interaction: ManagedRuntimeClientInteraction): void {
    if (interaction.expiresAt === undefined) {
      return;
    }
    const expiresAtMs = Date.parse(interaction.expiresAt);
    const remainingMs = expiresAtMs - this.now();
    if (remainingMs <= 0) {
      this.expire(interaction);
      return;
    }
    interaction.expiresTimer = setTimeout(
      () => {
        interaction.expiresTimer = undefined;
        if (this.interactions.get(interaction.key) !== interaction) {
          return;
        }
        if (this.isExpired(interaction)) {
          this.expire(interaction);
        } else {
          this.scheduleExpiration(interaction);
        }
      },
      Math.min(remainingMs, MAX_TIMEOUT_DELAY_MS),
    );
  }

  private isExpired(interaction: ManagedRuntimeClientInteraction): boolean {
    return interaction.expiresAt !== undefined && Date.parse(interaction.expiresAt) <= this.now();
  }

  private expire(interaction: ManagedRuntimeClientInteraction): void {
    if (
      interaction.expiresAt === undefined ||
      this.interactions.get(interaction.key) !== interaction
    ) {
      return;
    }
    const settlement = this.interactions.settle(interaction, {
      kind: "expired",
      expiresAt: interaction.expiresAt,
    });
    if (!settlement.settled) {
      return;
    }
    this.sendCancellation(interaction, settlement.retiredDelivery, "Runtime 请求已到期");
    interaction.reject(new RuntimeClientRequestExpiredError(interaction.expiresAt));
  }

  private sendCancellation(
    interaction: ManagedRuntimeClientInteraction,
    delivery: ManagedRuntimeClientDelivery | undefined,
    reason: string,
  ): void {
    if (delivery === undefined) {
      return;
    }
    try {
      const params = projectRuntimeServerRequestCancelParams(interaction.protocolVersion, {
        interactionId: interaction.interactionId,
        serverRequestId: delivery.id,
        ...(interaction.legacyApprovalId !== undefined
          ? { approvalId: interaction.legacyApprovalId }
          : {}),
        reason,
      });
      delivery.attachment.responder.send({
        jsonrpc: "2.0",
        method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
        params,
      });
    } catch {
      // The transport may already be gone. Local settlement remains fail-closed.
    }
  }

  private failAttachment(attachment: RuntimeClientResponderAttachment, error: Error): void {
    for (const interaction of this.interactions.pending()) {
      if (
        interaction.eligibleResponderId !== attachment.responder.id ||
        interaction.scopeId !== attachment.responder.scopeId ||
        (interaction.state.kind === "delivered" &&
          interaction.state.delivery.attachment !== attachment)
      ) {
        continue;
      }
      this.rejectInteraction(interaction, error);
    }
  }

  private getPendingInteractionProjectionsForAttachment(
    attachment: RuntimeClientResponderAttachment,
    threadId: ThreadId,
  ): readonly PendingInteractionProjection[] {
    if (
      this.responders.get(attachment.responder.id) !== attachment ||
      !attachment.capabilitiesAcknowledged
    ) {
      return [];
    }
    return this.interactions.pending().flatMap((interaction) => {
      if (
        interaction.eligibleResponderId !== attachment.responder.id ||
        interaction.scopeId !== attachment.responder.scopeId ||
        (interaction.state.kind === "delivered" &&
          interaction.state.delivery.attachment !== attachment) ||
        !getRuntimeProtocolCapabilities(interaction.protocolVersion)
          .serverRequestCapabilityNegotiation ||
        !attachment.acceptedServerRequestMethods.has(interaction.method)
      ) {
        return [];
      }
      if (interaction.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest) {
        const approval = approvalRequestParamsV12Schema.safeParse(interaction.params);
        if (!approval.success) {
          this.diagnose(
            `忽略无法投影的 pending Interaction "${interaction.key}"：params 不符合 1.2 schema`,
          );
          return [];
        }
        if (approval.data.threadId !== threadId) {
          return [];
        }
        return [
          pendingInteractionProjectionSchema.parse({
            method: interaction.method,
            interactionId: interaction.interactionId,
            threadId: approval.data.threadId,
            turnId: approval.data.turnId,
            expiresAt: approval.data.expiresAt,
            sensitivity: approval.data.sensitivity,
            approvalId: approval.data.approval.id,
          }),
        ];
      }
      const userInput = userInputRequestParamsV12Schema.safeParse(interaction.params);
      if (!userInput.success) {
        this.diagnose(
          `忽略无法投影的 pending Interaction "${interaction.key}"：params 不符合 1.2 schema`,
        );
        return [];
      }
      if (userInput.data.threadId !== threadId) {
        return [];
      }
      return [
        pendingInteractionProjectionSchema.parse({
          method: interaction.method,
          ...userInput.data,
        }),
      ];
    });
  }

  private diagnose(message: string): void {
    try {
      this.onDiagnostic?.(message);
    } catch {
      // Diagnostics are observers and cannot participate in request settlement.
    }
  }

  private redeliver(key: string, responderId: RuntimeClientResponderId): boolean {
    const interaction = this.interactions.get(key);
    const attachment = this.responders.get(responderId);
    if (
      interaction === undefined ||
      attachment === undefined ||
      interaction.eligibleResponderId !== responderId ||
      attachment.responder.scopeId !== interaction.scopeId ||
      !attachment.capabilitiesAcknowledged ||
      !attachment.acceptedServerRequestMethods.has(interaction.method) ||
      this.isExpired(interaction)
    ) {
      if (interaction !== undefined && this.isExpired(interaction)) {
        this.expire(interaction);
      }
      return false;
    }
    const replacement = this.interactions.replaceDelivery(interaction, attachment);
    if (replacement === undefined) {
      return false;
    }
    this.sendCancellation(interaction, replacement.previous, "Runtime 请求已重新投递");
    const activeReplacement = this.interactions.getByDeliveryId(replacement.delivery.id);
    if (
      activeReplacement?.interaction !== interaction ||
      activeReplacement.delivery !== replacement.delivery
    ) {
      return false;
    }
    if (this.isExpired(interaction)) {
      this.expire(interaction);
      return false;
    }
    this.sendDelivery(interaction, replacement.delivery);
    return this.interactions.get(interaction.key) === interaction;
  }

  private rejectInteraction(interaction: ManagedRuntimeClientInteraction, error: Error): boolean {
    const settlement = this.interactions.settle(interaction, { kind: "failed", error });
    if (!settlement.settled) {
      return false;
    }
    interaction.reject(error);
    return true;
  }

  private setServerRequestMethodsForAttachment(
    attachment: RuntimeClientResponderAttachment,
    methods: readonly RuntimeServerRequestMethod[],
    reason: string,
  ): (() => void) | false {
    const { responder } = attachment;
    if (this.responders.get(responder.id) !== attachment) {
      return false;
    }
    const accepted = new Set(methods);
    const removed = new Set(
      [...attachment.acceptedServerRequestMethods].filter((method) => !accepted.has(method)),
    );
    attachment.acceptedServerRequestMethods = accepted;
    attachment.capabilitiesAcknowledged = false;
    for (const interaction of this.interactions.pending()) {
      if (interaction.eligibleResponderId !== responder.id || !removed.has(interaction.method)) {
        continue;
      }
      const settlement = this.interactions.settle(interaction, { kind: "cancelled", reason });
      if (!settlement.settled) {
        continue;
      }
      this.sendCancellation(interaction, settlement.retiredDelivery, reason);
      interaction.reject(new RuntimeClientRequestCancelledError(reason));
    }
    return () => {
      if (
        this.responders.get(responder.id) !== attachment ||
        attachment.acceptedServerRequestMethods !== accepted
      ) {
        return;
      }
      attachment.capabilitiesAcknowledged = true;
      for (const interaction of this.interactions.pending()) {
        if (
          interaction.eligibleResponderId === responder.id &&
          interaction.state.kind === "waiting"
        ) {
          this.deliver(interaction);
        }
      }
    };
  }

  private beginCapabilityNegotiationForAttachment(
    attachment: RuntimeClientResponderAttachment,
  ): boolean {
    if (this.responders.get(attachment.responder.id) !== attachment) {
      return false;
    }
    attachment.acceptedServerRequestMethods = new Set();
    attachment.capabilitiesAcknowledged = false;
    return true;
  }
}

/** @internal Package-private transport binding and controlled redelivery. */
export function getRuntimeClientRequestCoordinatorInternal(
  coordinator: RuntimeClientRequestCoordinator,
): RuntimeClientRequestCoordinatorInternal {
  const internal = runtimeClientRequestCoordinatorInternals.get(coordinator);
  if (internal === undefined) {
    throw new RuntimeClientRequestError("Runtime client request coordinator is not initialized");
  }
  return internal;
}
