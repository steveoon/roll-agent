import type { ConversationEngine } from "../engine/conversation-engine.ts";
import type { AgentSession } from "../engine/agent-session.ts";
import {
  EVENT_NOTIFICATION,
  RpcMethod,
  abortParamsSchema,
  approveParamsSchema,
  closeParamsSchema,
  compactParamsSchema,
  createParamsSchema,
  isRequest,
  messagesParamsSchema,
  rejectParamsSchema,
  resumeParamsSchema,
  sendParamsSchema,
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

  abortAll(): void {
    for (const session of this.sessions.values()) {
      session.abort();
    }
    this.sessions.clear();
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
        session.abort();
        this.sessions.delete(params.sessionId);
        return { closed: true };
      }
      case RpcMethod.Messages: {
        const params = messagesParamsSchema.parse(request.params);
        return { messages: this.requireSession(params.sessionId).getMessages() };
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
