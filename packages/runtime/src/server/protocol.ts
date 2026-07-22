import { z } from "zod";

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: { readonly code: number; readonly message: string };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export interface JsonRpcConnection {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export const RpcMethod = {
  Create: "session.create",
  Resume: "session.resume",
  Send: "session.send",
  Approve: "session.approve",
  Reject: "session.reject",
  Abort: "session.abort",
  Close: "session.close",
  Messages: "session.messages",
  ToolExecutions: "session.toolExecutions",
  Capabilities: "session.capabilities",
  Compact: "session.compact",
} as const;

export const EVENT_NOTIFICATION = "session.event";

export const createParamsSchema = z.object({ title: z.string().optional() });
export const resumeParamsSchema = z.object({ threadId: z.string() });
export const sendParamsSchema = z.object({ sessionId: z.string(), input: z.string() });
export const approveParamsSchema = z.object({ sessionId: z.string(), approvalId: z.string() });
export const rejectParamsSchema = z.object({
  sessionId: z.string(),
  approvalId: z.string(),
  reason: z.string().optional(),
});
export const abortParamsSchema = z.object({ sessionId: z.string() });
export const closeParamsSchema = z.object({ sessionId: z.string() });
export const messagesParamsSchema = z.object({ sessionId: z.string() });
export const toolExecutionsParamsSchema = z.object({
  sessionId: z.string(),
  executionId: z.string().uuid().optional(),
  includeRaw: z
    .boolean()
    .default(false)
    .describe(
      "Requests bounded persisted Tool input/result evidence. RuntimeServer denies this by default; the host must provide an explicit authorization policy.",
    ),
  afterSequence: z.number().int().min(-1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  toolCallId: z.string().min(1).optional(),
});
export const capabilitiesParamsSchema = z.object({ sessionId: z.string() });
export const compactParamsSchema = z.object({ sessionId: z.string() });

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}
