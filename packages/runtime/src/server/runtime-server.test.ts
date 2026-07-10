import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { rollConfigSchema } from "@roll-agent/core/config/schema";
import { ConversationEngine } from "../engine/conversation-engine.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import type { SessionEvent } from "../types/events.ts";
import { RuntimeServer } from "./runtime-server.ts";
import {
  EVENT_NOTIFICATION,
  RpcMethod,
  type JsonRpcConnection,
  type JsonRpcMessage,
} from "./protocol.ts";

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };
const TOOL_CALLS: LanguageModelV4FinishReason = { unified: "tool-calls", raw: "tool-calls" };

const config = rollConfigSchema.parse({
  llm: { defaultProvider: "mock", defaultModel: "mock", providers: {} },
  ask: {},
  agents: { dataDir: "/tmp/roll-runtime-server-test" },
});

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function step(chunks: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function sequencedModel(steps: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return step(chunks);
    },
  });
}

function source(agentName: string, toolName: string): AgentToolSource {
  const client = {
    callTool: async () => ({ content: [{ type: "text", text: "result-ok" }] }),
  } as unknown as Client;
  return {
    agentName,
    client,
    tools: [
      {
        tool: {
          name: toolName,
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: undefined,
      },
    ],
  };
}

function memoryPair(): { serverConn: JsonRpcConnection; clientConn: JsonRpcConnection } {
  const serverHandlers: Array<(message: JsonRpcMessage) => void> = [];
  const clientHandlers: Array<(message: JsonRpcMessage) => void> = [];
  const make = (
    mine: Array<(message: JsonRpcMessage) => void>,
    theirs: Array<(message: JsonRpcMessage) => void>,
  ): JsonRpcConnection => ({
    send(message) {
      queueMicrotask(() => {
        for (const handler of theirs) {
          handler(message);
        }
      });
    },
    onMessage(handler) {
      mine.push(handler);
    },
    onClose() {},
    close() {},
  });
  return {
    serverConn: make(serverHandlers, clientHandlers),
    clientConn: make(clientHandlers, serverHandlers),
  };
}

test("RuntimeServer 完整往返：create → send → confirmation → approve → done", async () => {
  const { serverConn, clientConn } = memoryPair();
  const model = sequencedModel([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "msg-agent__send_message",
        input: JSON.stringify({ q: "hi" }),
      },
      { type: "finish", usage: usage(), finishReason: TOOL_CALLS },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "已发送" },
      { type: "text-end", id: "t" },
      { type: "finish", usage: usage(), finishReason: STOP },
    ],
  ]);

  const engine = new ConversationEngine({
    config,
    model,
    sources: [source("msg-agent", "send_message")],
    policy: new DefaultToolPolicy(),
  });
  const server = new RuntimeServer(engine, serverConn);
  assert.ok(server);

  const events: SessionEvent[] = [];
  const responses = new Map<number, (result: unknown) => void>();
  let sessionId = "";

  clientConn.onMessage((message) => {
    if ("method" in message && message.method === EVENT_NOTIFICATION) {
      const params = message.params as { readonly event: SessionEvent };
      events.push(params.event);
      if (params.event.type === "confirmation-required") {
        clientConn.send({
          jsonrpc: "2.0",
          id: 99,
          method: RpcMethod.Approve,
          params: { sessionId, approvalId: params.event.approvalId },
        });
      }
    } else if ("id" in message && "result" in message && typeof message.id === "number") {
      responses.get(message.id)?.(message.result);
    }
  });

  const request = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      responses.set(id, resolve);
      clientConn.send({ jsonrpc: "2.0", id, method, params });
    });

  const created = (await request(1, RpcMethod.Create, {})) as { sessionId: string };
  sessionId = created.sessionId;
  assert.ok(sessionId.length > 0);

  const sendResult = (await request(2, RpcMethod.Send, {
    sessionId,
    input: "send hi",
  })) as { status: string };
  assert.equal(sendResult.status, "completed");

  assert.ok(events.some((event) => event.type === "confirmation-required"));
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
  assert.ok(events.some((event) => event.type === "message-finish"));
});

test("RuntimeServer 支持 session.compact 并透传压缩事件", async () => {
  const { serverConn, clientConn } = memoryPair();
  const engine = new ConversationEngine({
    config,
    model: sequencedModel([[]]),
    sources: [],
  });
  const server = new RuntimeServer(engine, serverConn);
  assert.ok(server);

  const events: SessionEvent[] = [];
  const responses = new Map<number, (result: unknown) => void>();
  clientConn.onMessage((message) => {
    if ("method" in message && message.method === EVENT_NOTIFICATION) {
      const params = message.params as { readonly event: SessionEvent };
      events.push(params.event);
    } else if ("id" in message && "result" in message && typeof message.id === "number") {
      responses.get(message.id)?.(message.result);
    }
  });

  const request = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      responses.set(id, resolve);
      clientConn.send({ jsonrpc: "2.0", id, method, params });
    });

  const created = (await request(1, RpcMethod.Create, {})) as { sessionId: string };
  const compacted = (await request(2, RpcMethod.Compact, {
    sessionId: created.sessionId,
  })) as { status: string };

  assert.equal(compacted.status, "completed");
  assert.ok(events.some((event) => event.type === "context-compacted"));
  await engine.dispose();
});

test("RuntimeServer session.abort 取消当前 turn 并保留 session", async () => {
  const { serverConn, clientConn } = memoryPair();
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "too late" },
          { type: "text-end", id: "t" },
          { type: "finish", usage: usage(), finishReason: STOP },
        ],
        initialDelayInMs: 200,
        chunkDelayInMs: null,
      }),
    }),
  });
  const engine = new ConversationEngine({ config, model, sources: [] });
  const server = new RuntimeServer(engine, serverConn);
  assert.ok(server);

  const events: SessionEvent[] = [];
  const responses = new Map<number, (result: unknown) => void>();
  let sessionId = "";
  let abortResponse: Promise<unknown> | undefined;
  const request = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      responses.set(id, resolve);
      clientConn.send({ jsonrpc: "2.0", id, method, params });
    });
  clientConn.onMessage((message) => {
    if ("method" in message && message.method === EVENT_NOTIFICATION) {
      const params = message.params as { readonly event: SessionEvent };
      events.push(params.event);
      if (params.event.type === "message-start" && abortResponse === undefined) {
        abortResponse = request(3, RpcMethod.Abort, { sessionId });
      }
    } else if ("id" in message && "result" in message && typeof message.id === "number") {
      responses.get(message.id)?.(message.result);
    }
  });

  const created = (await request(1, RpcMethod.Create, {})) as { sessionId: string };
  sessionId = created.sessionId;
  const sent = (await request(2, RpcMethod.Send, { sessionId, input: "slow" })) as {
    status: string;
  };
  assert.equal(sent.status, "completed");
  assert.ok(abortResponse);
  await abortResponse;
  const cancelled = events.find((event) => event.type === "turn-cancelled");
  assert.ok(cancelled && cancelled.type === "turn-cancelled");
  assert.equal(cancelled.reason, "user");
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  await engine.dispose();
});

test("RuntimeServer session.close 完整释放并移除 session", async () => {
  const { serverConn, clientConn } = memoryPair();
  const engine = new ConversationEngine({
    config,
    model: sequencedModel([[]]),
    sources: [],
  });
  const server = new RuntimeServer(engine, serverConn);
  assert.ok(server);

  const responses = new Map<number, (result: unknown) => void>();
  const errors = new Map<number, (error: unknown) => void>();
  clientConn.onMessage((message) => {
    if ("id" in message && "result" in message && typeof message.id === "number") {
      responses.get(message.id)?.(message.result);
    } else if ("id" in message && "error" in message && typeof message.id === "number") {
      errors.get(message.id)?.(message.error);
    }
  });
  const request = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      responses.set(id, resolve);
      clientConn.send({ jsonrpc: "2.0", id, method, params });
    });

  const created = (await request(1, RpcMethod.Create, {})) as { sessionId: string };
  const closed = (await request(2, RpcMethod.Close, {
    sessionId: created.sessionId,
  })) as { closed: boolean };
  assert.equal(closed.closed, true);

  const error = await new Promise<unknown>((resolve) => {
    errors.set(3, resolve);
    clientConn.send({
      jsonrpc: "2.0",
      id: 3,
      method: RpcMethod.Messages,
      params: { sessionId: created.sessionId },
    });
  });
  assert.ok(error && typeof error === "object" && "message" in error);
  await engine.dispose();
});

test("RuntimeServer 未知 session 返回错误响应", async () => {
  const { serverConn, clientConn } = memoryPair();
  const engine = new ConversationEngine({
    config,
    model: sequencedModel([[]]),
    sources: [],
  });
  const server = new RuntimeServer(engine, serverConn);
  assert.ok(server);

  const errors = new Map<number, (error: unknown) => void>();
  clientConn.onMessage((message) => {
    if ("id" in message && "error" in message && typeof message.id === "number") {
      errors.get(message.id)?.(message.error);
    }
  });

  const error = await new Promise<unknown>((resolve) => {
    errors.set(1, resolve);
    clientConn.send({
      jsonrpc: "2.0",
      id: 1,
      method: RpcMethod.Send,
      params: { sessionId: "missing", input: "x" },
    });
  });
  assert.ok(error && typeof error === "object" && "message" in error);
});
