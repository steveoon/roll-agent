import type { ConversationEngine } from "../engine/conversation-engine.ts";
import type { AgentSession } from "../engine/agent-session.ts";
import { createSafeCapabilitySnapshot } from "../engine/capability-manifest.ts";
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

export class RuntimeServer {
  private readonly engine: ConversationEngine;
  private readonly connection: JsonRpcConnection;
  private readonly sessions = new Map<string, AgentSession>();

  constructor(engine: ConversationEngine, connection: JsonRpcConnection) {
    this.engine = engine;
    this.connection = connection;
    this.connection.onMessage((message) => this.handleMessage(message));
  }

  async abortAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (!isRequest(message)) {
      return;
    }
    this.dispatch(message)
      .then((result) => {
        this.connection.send({ jsonrpc: "2.0", id: message.id, result });
      })
      .catch((error: unknown) => {
        this.connection.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: errorMessage(error) },
        });
      });
  }

  private requireSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" 不存在`);
    }
    return session;
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
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
          this.connection.send({
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
        if (params.executionId !== undefined) {
          return {
            record: session.getToolExecution(params.executionId, params.includeRaw),
          };
        }
        return {
          records: session.getToolExecutions(
            {
              ...(params.afterSequence !== undefined
                ? { afterSequence: params.afterSequence }
                : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
              ...(params.toolCallId !== undefined ? { toolCallId: params.toolCallId } : {}),
            },
            params.includeRaw,
          ),
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
          this.connection.send({
            jsonrpc: "2.0",
            method: EVENT_NOTIFICATION,
            params: { sessionId: params.sessionId, event },
          });
        }
        return { status: "completed" };
      }
      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }
}
