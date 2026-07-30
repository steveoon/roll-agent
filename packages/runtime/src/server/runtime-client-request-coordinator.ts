import { randomUUID } from "node:crypto";
import {
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  parseRuntimeServerRequestParams,
  parseRuntimeServerRequestResult,
  runtimeServerRequestCancelParamsSchema,
  timestampSchema,
  type ApprovalId,
  type JsonRpcId,
  type RuntimeInstanceId,
  type RuntimeServerRequestInput,
  type RuntimeServerRequestMethod,
  type RuntimeServerRequestResult,
  type ThreadId,
  type TurnId,
} from "@roll-agent/protocol";
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
}

interface RuntimeClientRequestDelivery {
  readonly key: string;
  readonly requestId: JsonRpcId;
  readonly responderId: RuntimeClientResponderId;
}

interface PendingRuntimeClientRequest {
  readonly key: string;
  readonly method: RuntimeServerRequestMethod;
  readonly params: unknown;
  readonly scopeId: RuntimeInstanceId;
  readonly eligibleResponderId: RuntimeClientResponderId;
  readonly approvalId: ApprovalId | undefined;
  readonly threadId: ThreadId | undefined;
  readonly turnId: TurnId | undefined;
  readonly expiresAt: string | undefined;
  readonly reject: (error: Error) => void;
  readonly resolve: (result: unknown) => void;
  expiresTimer: ReturnType<typeof setTimeout> | undefined;
  delivery: RuntimeClientRequestDelivery | undefined;
}

export interface RuntimeClientRequestOptions {
  readonly key: string;
  readonly scopeId: RuntimeInstanceId;
  readonly eligibleResponderId: RuntimeClientResponderId;
  readonly approvalId?: ApprovalId;
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
  readonly expiresAt?: string;
}

export interface RuntimeClientRequest<TMethod extends RuntimeServerRequestMethod> {
  readonly key: string;
  readonly result: Promise<RuntimeServerRequestResult<TMethod>>;
}

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
  private readonly pendingByKey = new Map<string, PendingRuntimeClientRequest>();
  private readonly deliveries = new Map<JsonRpcId, RuntimeClientRequestDelivery>();

  constructor(options: RuntimeClientRequestCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onDiagnostic = options.onDiagnostic;
  }

  attachResponder(responder: RuntimeClientResponder): () => void {
    if (this.responders.has(responder.id)) {
      throw new RuntimeClientRequestError(`Runtime responder "${responder.id}" 已连接`);
    }
    const attachment: RuntimeClientResponderAttachment = { responder };
    this.responders.set(responder.id, attachment);
    return () => {
      this.detachResponder(attachment, "Runtime 客户端连接已关闭");
    };
  }

  request<TMethod extends RuntimeServerRequestMethod>(
    method: TMethod,
    params: RuntimeServerRequestInput<TMethod>,
    options: RuntimeClientRequestOptions,
  ): RuntimeClientRequest<TMethod> {
    if (this.pendingByKey.has(options.key)) {
      throw new RuntimeClientRequestError(`Runtime 请求 "${options.key}" 已存在`);
    }
    const parsedParams = parseRuntimeServerRequestParams(method, params);
    let expiresAt: string | undefined;
    if (options.expiresAt !== undefined) {
      const parsedExpiresAt = timestampSchema.safeParse(options.expiresAt);
      if (!parsedExpiresAt.success || !Number.isFinite(Date.parse(parsedExpiresAt.data))) {
        throw new RuntimeClientRequestError("Runtime 请求 expiresAt 必须是有效的 ISO 8601 时间戳");
      }
      expiresAt = parsedExpiresAt.data;
    }
    const deferred = Promise.withResolvers<RuntimeServerRequestResult<TMethod>>();
    const pending: PendingRuntimeClientRequest = {
      key: options.key,
      method,
      params: parsedParams,
      scopeId: options.scopeId,
      eligibleResponderId: options.eligibleResponderId,
      approvalId: options.approvalId,
      threadId: options.threadId,
      turnId: options.turnId,
      expiresAt,
      reject: deferred.reject,
      resolve: (value) => {
        try {
          deferred.resolve(parseRuntimeServerRequestResult(method, value));
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
      expiresTimer: undefined,
      delivery: undefined,
    };
    this.pendingByKey.set(pending.key, pending);
    this.scheduleExpiration(pending);
    if (this.pendingByKey.get(pending.key) === pending) {
      this.deliver(pending);
    }
    return {
      key: pending.key,
      result: deferred.promise,
    };
  }

  handleResponse(responderId: RuntimeClientResponderId, message: JsonRpcMessage): boolean {
    if ("method" in message || !("id" in message)) {
      return false;
    }
    const attachment = this.responders.get(responderId);
    const responder = attachment?.responder;
    if (message.id === null) {
      const detail =
        "error" in message
          ? `${message.error.code} ${message.error.message}`
          : "客户端返回了非法的 id:null 成功响应";
      this.failResponder(
        responderId,
        new RuntimeClientRequestError(`客户端返回无法关联的 JSON-RPC 错误：${detail}`),
      );
      if (attachment !== undefined && this.responders.get(responderId) === attachment) {
        this.responders.delete(responderId);
      }
      try {
        responder?.close();
      } catch {
        // Correlated requests were already failed closed.
      }
      return true;
    }
    const delivery = this.deliveries.get(message.id);
    if (delivery === undefined) {
      return false;
    }
    if (delivery.responderId !== responderId) {
      this.diagnose(
        `忽略来自非目标 responder "${responderId}" 的 Runtime 响应 ${String(message.id)}`,
      );
      return true;
    }
    const pending = this.pendingByKey.get(delivery.key);
    if (pending === undefined) {
      this.deliveries.delete(message.id);
      return true;
    }
    if (responder === undefined || responder.scopeId !== pending.scopeId) {
      this.diagnose(`忽略 Runtime scope 不匹配的响应 ${String(message.id)} (${pending.key})`);
      return true;
    }
    this.removePending(pending);
    if ("error" in message) {
      pending.reject(
        new RuntimeClientRequestError(
          `客户端未完成 Runtime 请求：${message.error.code} ${message.error.message}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
    return true;
  }

  cancel(key: string, reason: string): boolean {
    const pending = this.pendingByKey.get(key);
    if (pending === undefined) {
      return false;
    }
    const cancellationReason =
      typeof reason === "string" && reason.length > 0 ? reason : DEFAULT_CANCELLATION_REASON;
    try {
      this.sendCancellation(pending, cancellationReason);
    } finally {
      this.removePending(pending);
      pending.reject(new RuntimeClientRequestCancelledError(cancellationReason));
    }
    return true;
  }

  cancelAll(reason: string): void {
    for (const key of [...this.pendingByKey.keys()]) {
      this.cancel(key, reason);
    }
  }

  private detachResponder(attachment: RuntimeClientResponderAttachment, reason: string): void {
    const { responder } = attachment;
    if (this.responders.get(responder.id) !== attachment) {
      return;
    }
    const affected = [...this.pendingByKey.values()].filter(
      (pending) => pending.delivery?.responderId === responder.id,
    );
    for (const pending of affected) {
      if (pending.delivery !== undefined) {
        this.sendCancellation(pending, reason);
        this.deliveries.delete(pending.delivery.requestId);
        pending.delivery = undefined;
      }
      this.removePending(pending);
      pending.reject(new RuntimeClientRequestCancelledError(reason));
    }
    this.responders.delete(responder.id);
  }

  private deliver(pending: PendingRuntimeClientRequest): void {
    if (this.isExpired(pending)) {
      this.expire(pending);
      return;
    }
    const responder = this.responders.get(pending.eligibleResponderId)?.responder;
    if (responder === undefined || responder.scopeId !== pending.scopeId) {
      this.removePending(pending);
      pending.reject(new RuntimeClientRequestError("没有可处理 Runtime 请求的目标客户端"));
      return;
    }
    const delivery: RuntimeClientRequestDelivery = {
      key: pending.key,
      requestId: `runtime:${randomUUID()}`,
      responderId: responder.id,
    };
    pending.delivery = delivery;
    this.deliveries.set(delivery.requestId, delivery);
    try {
      responder.send({
        jsonrpc: "2.0",
        id: delivery.requestId,
        method: pending.method,
        params: pending.params,
      });
    } catch (error: unknown) {
      this.removePending(pending);
      pending.reject(
        new RuntimeClientRequestError(
          error instanceof Error
            ? `Runtime 请求发送失败：${error.message}`
            : "Runtime 请求发送失败",
        ),
      );
    }
  }

  private scheduleExpiration(pending: PendingRuntimeClientRequest): void {
    if (pending.expiresAt === undefined) {
      return;
    }
    const expiresAtMs = Date.parse(pending.expiresAt);
    const remainingMs = expiresAtMs - this.now();
    if (remainingMs <= 0) {
      this.expire(pending);
      return;
    }
    pending.expiresTimer = setTimeout(
      () => {
        pending.expiresTimer = undefined;
        if (this.pendingByKey.get(pending.key) !== pending) {
          return;
        }
        if (this.isExpired(pending)) {
          this.expire(pending);
        } else {
          this.scheduleExpiration(pending);
        }
      },
      Math.min(remainingMs, MAX_TIMEOUT_DELAY_MS),
    );
  }

  private isExpired(pending: PendingRuntimeClientRequest): boolean {
    return pending.expiresAt !== undefined && Date.parse(pending.expiresAt) <= this.now();
  }

  private expire(pending: PendingRuntimeClientRequest): void {
    if (pending.expiresAt === undefined || this.pendingByKey.get(pending.key) !== pending) {
      return;
    }
    this.sendCancellation(pending, "Runtime 请求已到期");
    this.removePending(pending);
    pending.reject(new RuntimeClientRequestExpiredError(pending.expiresAt));
  }

  private sendCancellation(pending: PendingRuntimeClientRequest, reason: string): void {
    const delivery = pending.delivery;
    if (delivery === undefined) {
      return;
    }
    const responder = this.responders.get(delivery.responderId)?.responder;
    try {
      const params = runtimeServerRequestCancelParamsSchema.parse({
        serverRequestId: delivery.requestId,
        ...(pending.approvalId !== undefined ? { approvalId: pending.approvalId } : {}),
        reason,
      });
      responder?.send({
        jsonrpc: "2.0",
        method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
        params,
      });
    } catch {
      // The transport may already be gone. Local settlement remains fail-closed.
    }
  }

  private failResponder(responderId: RuntimeClientResponderId, error: Error): void {
    const affected = [...this.pendingByKey.values()].filter(
      (pending) => pending.delivery?.responderId === responderId,
    );
    for (const pending of affected) {
      this.removePending(pending);
      pending.reject(error);
    }
  }

  private diagnose(message: string): void {
    try {
      this.onDiagnostic?.(message);
    } catch {
      // Diagnostics are observers and cannot participate in request settlement.
    }
  }

  private removePending(pending: PendingRuntimeClientRequest): void {
    if (this.pendingByKey.get(pending.key) === pending) {
      this.pendingByKey.delete(pending.key);
    }
    if (pending.expiresTimer !== undefined) {
      clearTimeout(pending.expiresTimer);
      pending.expiresTimer = undefined;
    }
    if (pending.delivery !== undefined) {
      this.deliveries.delete(pending.delivery.requestId);
      pending.delivery = undefined;
    }
  }
}
