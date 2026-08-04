import type { ConversationEngine } from "../engine/conversation-engine.ts";
import {
  RUNTIME_ERROR_CODES,
  jsonValueSchema,
  type RuntimeProtocolErrorDataV12,
} from "@roll-agent/protocol";
import type { AgentSession } from "../engine/agent-session.ts";
import { createSafeCapabilitySnapshot } from "../engine/capability-manifest.ts";
import { isPersistedToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { RuntimeServiceError, type RuntimeService } from "../service/runtime-service.ts";
import { RuntimeClientRequestCoordinator } from "./runtime-client-request-coordinator.ts";
import { RuntimeProtocolAdapter } from "./runtime-protocol-adapter.ts";
import {
  EVENT_NOTIFICATION,
  RpcMethod,
  abortParamsSchema,
  approveParamsSchema,
  capabilitiesParamsSchema,
  closeParamsSchema,
  compactParamsSchema,
  createParamsSchema,
  isRequest,
  messagesParamsSchema,
  rejectParamsSchema,
  resumeParamsSchema,
  sendParamsSchema,
  toolExecutionsParamsSchema,
  type JsonRpcConnection,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./protocol.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class MethodNotFoundError extends Error {}
class RuntimeTransportWriteError extends Error {}

function isValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}

function toJsonRpcError(
  error: unknown,
  hideInternalMessage: boolean,
): {
  readonly code: number;
  readonly message: string;
  readonly data?: RuntimeProtocolErrorDataV12;
} {
  if (error instanceof RuntimeServiceError) {
    const details = jsonValueSchema.safeParse(error.details);
    return {
      code: -32_000,
      message: error.message,
      data: {
        rollCode: error.rollCode,
        retryable: error.retryable,
        ...(details.success ? { details: details.data } : {}),
      },
    };
  }
  if (isValidationError(error)) {
    return {
      code: -32_602,
      message: "Invalid params",
      data: {
        rollCode: "INVALID_PARAMS",
        retryable: false,
      },
    };
  }
  if (error instanceof MethodNotFoundError) {
    return {
      code: -32_601,
      message: error.message,
    };
  }
  return {
    code: -32_603,
    message: hideInternalMessage ? "Internal error" : errorMessage(error),
    data: {
      rollCode: "INTERNAL_ERROR",
      retryable: false,
    },
  };
}

export interface RawToolEvidenceAccessRequest {
  readonly sessionId: string;
  readonly executionId?: string;
}

export interface RuntimeServerOptions {
  /**
   * Explicit host authorization boundary for bounded raw/input ledger projections.
   * Omission is deny-by-default; `includeRaw: true` is only a request, never authorization.
   */
  readonly authorizeRawToolEvidence?: (
    request: RawToolEvidenceAccessRequest,
  ) => boolean | Promise<boolean>;
  /**
   * Versioned public Runtime Protocol adapter. Legacy `session.*` remains available on legacy
   * connections, but a connection cannot mix the two protocol families.
   */
  readonly runtimeService?: RuntimeService;
  /** Optional service-lifetime coordinator injected into this service's single control adapter. */
  readonly runtimeClientRequests?: RuntimeClientRequestCoordinator;
}

const CONNECTION_MODES = {
  unselected: "unselected",
  legacy: "legacy",
  runtime: "runtime",
} as const;

type ConnectionMode = (typeof CONNECTION_MODES)[keyof typeof CONNECTION_MODES];

const LEGACY_METHODS = new Set<string>(Object.values(RpcMethod));

/**
 * JSON-RPC host for trusted local transports.
 *
 * This class does not authenticate the connection or infer tenant ownership. Tool execution
 * queries default to a redacted projection, and `includeRaw: true` remains denied unless the host
 * supplies `authorizeRawToolEvidence`. Even authorized reads return the bounded, write-time
 * redacted persistence projection rather than the original in-memory protocol result.
 */
export class RuntimeServer {
  private readonly engine: ConversationEngine;
  private readonly connection: JsonRpcConnection;
  private readonly authorizeRawToolEvidence:
    | RuntimeServerOptions["authorizeRawToolEvidence"]
    | undefined;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly runtimeService: RuntimeService | undefined;
  private readonly runtimeClientRequests: RuntimeClientRequestCoordinator | undefined;
  private readonly protocolAdapter: RuntimeProtocolAdapter | undefined;
  private connectionMode: ConnectionMode = CONNECTION_MODES.unselected;
  private abortPromise: Promise<void> | undefined;

  constructor(
    engine: ConversationEngine,
    connection: JsonRpcConnection,
    options: RuntimeServerOptions = {},
  ) {
    this.engine = engine;
    this.connection = connection;
    this.authorizeRawToolEvidence = options.authorizeRawToolEvidence;
    this.runtimeService = options.runtimeService;
    this.runtimeClientRequests =
      options.runtimeService === undefined
        ? undefined
        : (options.runtimeClientRequests ?? new RuntimeClientRequestCoordinator());
    this.protocolAdapter =
      options.runtimeService === undefined || this.runtimeClientRequests === undefined
        ? undefined
        : new RuntimeProtocolAdapter(
            options.runtimeService,
            connection,
            this.runtimeClientRequests,
          );
    try {
      this.connection.onMessage((message) => this.handleMessage(message));
    } catch (error: unknown) {
      this.protocolAdapter?.disposeConstructionFailure();
      throw error;
    }
  }

  async abortAll(): Promise<void> {
    this.abortPromise ??= this.performAbortAll();
    await this.abortPromise;
  }

  private async performAbortAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const protocolClose = this.protocolAdapter?.close();
    this.runtimeClientRequests?.cancelAll("Runtime Server 已关闭");
    try {
      await Promise.all([
        ...sessions.map((session) => session.close()),
        ...(protocolClose === undefined ? [] : [protocolClose]),
        ...(this.runtimeService === undefined ? [] : [this.runtimeService.close()]),
      ]);
    } finally {
      this.protocolAdapter?.releaseServiceControl();
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (this.protocolAdapter?.handleResponse(message) === true) {
      return;
    }
    if (!isRequest(message)) {
      return;
    }
    const isRuntimeProtocolRequest = this.protocolAdapter?.handles(message.method) === true;
    try {
      this.selectConnectionMode(message.method, isRuntimeProtocolRequest);
    } catch (error: unknown) {
      this.sendOrClose({
        jsonrpc: "2.0",
        id: message.id,
        error: toJsonRpcError(error, isRuntimeProtocolRequest),
      });
      return;
    }
    this.dispatch(message).then(
      (result) => {
        this.sendOrClose({ jsonrpc: "2.0", id: message.id, result });
      },
      (error: unknown) => {
        if (error instanceof RuntimeTransportWriteError) {
          return;
        }
        this.sendOrClose({
          jsonrpc: "2.0",
          id: message.id,
          error: toJsonRpcError(error, isRuntimeProtocolRequest),
        });
      },
    );
  }

  private sendOrClose(message: JsonRpcMessage): boolean {
    try {
      this.connection.send(message);
      return true;
    } catch {
      try {
        this.connection.close();
      } catch {
        // The transport is already unusable; there is no further response path.
      }
      return false;
    }
  }

  private sendNotificationOrThrow(message: JsonRpcMessage): void {
    if (!this.sendOrClose(message)) {
      throw new RuntimeTransportWriteError("Runtime transport write failed");
    }
  }

  private requireSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" 不存在`);
    }
    return session;
  }

  private selectConnectionMode(method: string, isRuntimeProtocolRequest: boolean): void {
    if (isRuntimeProtocolRequest) {
      if (this.connectionMode === CONNECTION_MODES.legacy) {
        throw new RuntimeServiceError(
          RUNTIME_ERROR_CODES.capabilityUnavailable,
          "当前连接已选择 legacy session.* 协议，不能切换到 Runtime Protocol",
        );
      }
      this.connectionMode = CONNECTION_MODES.runtime;
      return;
    }
    if (!LEGACY_METHODS.has(method)) {
      return;
    }
    if (this.connectionMode === CONNECTION_MODES.runtime) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        "当前连接已选择 Runtime Protocol，不能调用 legacy session.* 方法",
      );
    }
    this.connectionMode = CONNECTION_MODES.legacy;
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    if (this.protocolAdapter?.handles(request.method) === true) {
      return this.protocolAdapter.dispatch(request);
    }
    switch (request.method) {
      case RpcMethod.Create: {
        const params = createParamsSchema.parse(request.params);
        const session = await this.engine.createSession(
          params.title ? { title: params.title } : {},
        );
        this.sessions.set(session.id, session);
        return { sessionId: session.id };
      }
      case RpcMethod.Resume: {
        const params = resumeParamsSchema.parse(request.params);
        const session = await this.engine.resumeSession(params.threadId);
        this.sessions.set(session.id, session);
        return { sessionId: session.id };
      }
      case RpcMethod.Send: {
        const params = sendParamsSchema.parse(request.params);
        const session = this.requireSession(params.sessionId);
        for await (const event of session.send(params.input)) {
          this.sendNotificationOrThrow({
            jsonrpc: "2.0",
            method: EVENT_NOTIFICATION,
            params: { sessionId: params.sessionId, event },
          });
        }
        return { status: "completed" };
      }
      case RpcMethod.Approve: {
        const params = approveParamsSchema.parse(request.params);
        return { resolved: this.requireSession(params.sessionId).approve(params.approvalId) };
      }
      case RpcMethod.Reject: {
        const params = rejectParamsSchema.parse(request.params);
        return {
          resolved: this.requireSession(params.sessionId).reject(params.approvalId, params.reason),
        };
      }
      case RpcMethod.Abort: {
        const params = abortParamsSchema.parse(request.params);
        return { ok: true, cancelled: this.requireSession(params.sessionId).cancel() };
      }
      case RpcMethod.Close: {
        const params = closeParamsSchema.parse(request.params);
        const session = this.requireSession(params.sessionId);
        await session.close();
        this.sessions.delete(params.sessionId);
        return { closed: true };
      }
      case RpcMethod.Messages: {
        const params = messagesParamsSchema.parse(request.params);
        return { messages: this.requireSession(params.sessionId).getMessages() };
      }
      case RpcMethod.ToolExecutions: {
        const params = toolExecutionsParamsSchema.parse(request.params);
        const session = this.requireSession(params.sessionId);
        if (
          params.includeRaw &&
          !(
            (await this.authorizeRawToolEvidence?.({
              sessionId: params.sessionId,
              ...(params.executionId !== undefined ? { executionId: params.executionId } : {}),
            })) ?? false
          )
        ) {
          throw new Error("Raw Tool evidence access denied by RuntimeServer policy");
        }
        if (params.executionId !== undefined) {
          const record = session.getToolExecution(params.executionId, params.includeRaw);
          if (
            params.includeRaw &&
            record !== undefined &&
            !isPersistedToolExecutionRecord(record)
          ) {
            throw new Error("Raw Tool evidence is unavailable without a durable ledger projection");
          }
          return {
            record,
          };
        }
        const records = session.getToolExecutions(
          {
            ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...(params.toolCallId !== undefined ? { toolCallId: params.toolCallId } : {}),
          },
          params.includeRaw,
        );
        if (
          params.includeRaw &&
          records.some((record) => !isPersistedToolExecutionRecord(record))
        ) {
          throw new Error("Raw Tool evidence is unavailable without a durable ledger projection");
        }
        return {
          records,
        };
      }
      case RpcMethod.Capabilities: {
        const params = capabilitiesParamsSchema.parse(request.params);
        const session = this.requireSession(params.sessionId);
        return createSafeCapabilitySnapshot(
          session.getCapabilityManifest(),
          session.getCapabilityTurnContext(),
        );
      }
      case RpcMethod.Compact: {
        const params = compactParamsSchema.parse(request.params);
        const session = this.requireSession(params.sessionId);
        for await (const event of session.compact("manual")) {
          this.sendNotificationOrThrow({
            jsonrpc: "2.0",
            method: EVENT_NOTIFICATION,
            params: { sessionId: params.sessionId, event },
          });
        }
        return { status: "completed" };
      }
      default:
        throw new MethodNotFoundError(`Method not found: ${request.method}`);
    }
  }
}
