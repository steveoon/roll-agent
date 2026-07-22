import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { rollConfigSchema } from "@roll-agent/core/config/schema";
import { ConversationEngine } from "../engine/conversation-engine.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import { ThreadStore } from "../store/thread-store.ts";
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
  const secret = "runtime-server-secret";
  const client = {
    callTool: async () => ({ content: [{ type: "text", text: "result-ok" }] }),
  } as unknown as Client;
  return {
    agentName,
    client,
    agentSource: "local-path",
    transport: "stdio",
    runtimeOwnership: "on-demand",
    tools: [
      {
        tool: {
          name: toolName,
          description: `apiKey=${secret} data:image/png;base64,${"a".repeat(2_048)}`,
          inputSchema: {
            type: "object" as const,
            properties: {
              q: { type: "string" },
              apiKey: {
                type: "string",
                default: secret,
                examples: [secret],
              },
            },
            required: ["q"],
          },
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ],
  };
}

function failingSource(agentName: string, toolName: string, message: string): AgentToolSource {
  const client = {
    callTool: async () => {
      throw new Error(message);
    },
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

function abortableSource(
  agentName: string,
  toolName: string,
  onStart: () => void,
): AgentToolSource {
  const client = {
    callTool: async (
      _request: unknown,
      _resultSchema: unknown,
      options: { readonly signal?: AbortSignal } | undefined,
    ) => {
      onStart();
      await new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
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

test("RuntimeServer 完整往返：create → send → confirmation → approve → done", async (t) => {
  const { serverConn, clientConn } = memoryPair();
  const storeDir = mkdtempSync(join(tmpdir(), "roll-runtime-server-ledger-"));
  const store = new ThreadStore(storeDir);
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
    store,
  });
  t.after(async () => {
    await engine.dispose();
    store.close();
    rmSync(storeDir, { recursive: true, force: true });
  });
  const server = new RuntimeServer(engine, serverConn, {
    authorizeRawToolEvidence: () => true,
  });
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
  assert.ok(toolResult.executionId);
  assert.ok(events.some((event) => event.type === "message-finish"));

  const redacted = (await request(4, RpcMethod.ToolExecutions, { sessionId })) as {
    readonly records: ReadonlyArray<{
      readonly id: string;
      readonly input: { readonly encoding: string };
      readonly raw: { readonly encoding: string };
    }>;
  };
  assert.equal(redacted.records.length, 1);
  assert.equal(redacted.records[0]?.id, toolResult.executionId);
  assert.equal(redacted.records[0]?.input.encoding, "redacted");
  assert.equal(redacted.records[0]?.raw.encoding, "redacted");

  const forensic = (await request(5, RpcMethod.ToolExecutions, {
    sessionId,
    executionId: toolResult.executionId,
    includeRaw: true,
  })) as {
    readonly record: {
      readonly input: { readonly encoding: string; readonly value: unknown };
      readonly outcome: { readonly kind: string };
    };
  };
  assert.equal(forensic.record.input.encoding, "json");
  assert.deepEqual(forensic.record.input.value, { q: "hi" });
  assert.equal(forensic.record.outcome.kind, "success");

  const capabilities = (await request(6, RpcMethod.Capabilities, { sessionId })) as {
    readonly manifest: {
      readonly tools: ReadonlyArray<{
        readonly id: string;
        readonly agentName: string;
        readonly toolName: string;
        readonly source: string;
        readonly transport?: string;
        readonly runtimeOwnership?: string;
        readonly annotations?: {
          readonly readOnlyHint?: boolean;
          readonly destructiveHint?: boolean;
        };
      }>;
    };
    readonly turnContext: {
      readonly effectiveToolIds: readonly string[];
      readonly explicitSkillNames: readonly string[];
    };
  };
  assert.ok(
    capabilities.manifest.tools.some(
      (item) =>
        item.id === "msg-agent__send_message" &&
        item.agentName === "msg-agent" &&
        item.toolName === "send_message" &&
        item.source === "local-path" &&
        item.transport === "stdio" &&
        item.runtimeOwnership === "on-demand" &&
        item.annotations?.destructiveHint === true,
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(capabilities),
    /runtime-server-secret|data:image|base64|"(?:default|example|examples)"/u,
  );
  assert.ok(capabilities.turnContext.effectiveToolIds.includes("msg-agent__send_message"));
  assert.deepEqual(capabilities.turnContext.explicitSkillNames, []);
});

test("RuntimeServer 默认拒绝 includeRaw，即使请求来自可用 session", async () => {
  const { serverConn, clientConn } = memoryPair();
  const engine = new ConversationEngine({
    config,
    model: sequencedModel([[]]),
    sources: [],
  });
  const server = new RuntimeServer(engine, serverConn);
  assert.ok(server);

  const results = new Map<number, (result: unknown) => void>();
  const errors = new Map<number, (error: unknown) => void>();
  clientConn.onMessage((message) => {
    if ("id" in message && typeof message.id === "number") {
      if ("result" in message) {
        results.get(message.id)?.(message.result);
      } else if ("error" in message) {
        errors.get(message.id)?.(message.error);
      }
    }
  });
  const request = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      results.set(id, resolve);
      clientConn.send({ jsonrpc: "2.0", id, method, params });
    });

  const created = (await request(1, RpcMethod.Create, {})) as { readonly sessionId: string };
  const error = await new Promise<unknown>((resolve) => {
    errors.set(2, resolve);
    clientConn.send({
      jsonrpc: "2.0",
      id: 2,
      method: RpcMethod.ToolExecutions,
      params: { sessionId: created.sessionId, includeRaw: true },
    });
  });
  assert.ok(error && typeof error === "object" && "message" in error);
  assert.match(String((error as { readonly message: unknown }).message), /access denied/u);
  await engine.dispose();
});

test("RuntimeServer 即使授权也不会从无 Store session 返回完整内存 raw", async () => {
  const { serverConn, clientConn } = memoryPair();
  const model = sequencedModel([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "in-memory-only",
        toolName: "fail-agent__read",
        input: JSON.stringify({ q: "secret-input" }),
      },
      { type: "finish", usage: usage(), finishReason: TOOL_CALLS },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "recovered" },
      { type: "text-end", id: "t" },
      { type: "finish", usage: usage(), finishReason: STOP },
    ],
  ]);
  const engine = new ConversationEngine({
    config,
    model,
    sources: [failingSource("fail-agent", "read", "secret-result")],
  });
  const server = new RuntimeServer(engine, serverConn, {
    authorizeRawToolEvidence: () => true,
  });
  assert.ok(server);

  const results = new Map<number, (result: unknown) => void>();
  const errors = new Map<number, (error: unknown) => void>();
  clientConn.onMessage((message) => {
    if ("id" in message && typeof message.id === "number") {
      if ("result" in message) {
        results.get(message.id)?.(message.result);
      } else if ("error" in message) {
        errors.get(message.id)?.(message.error);
      }
    }
  });
  const request = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      results.set(id, resolve);
      clientConn.send({ jsonrpc: "2.0", id, method, params });
    });

  const created = (await request(1, RpcMethod.Create, {})) as { readonly sessionId: string };
  await request(2, RpcMethod.Send, {
    sessionId: created.sessionId,
    input: "run in memory tool",
  });
  const error = await new Promise<unknown>((resolve) => {
    errors.set(3, resolve);
    clientConn.send({
      jsonrpc: "2.0",
      id: 3,
      method: RpcMethod.ToolExecutions,
      params: { sessionId: created.sessionId, includeRaw: true },
    });
  });
  assert.ok(error && typeof error === "object" && "message" in error);
  assert.match(String((error as { readonly message: unknown }).message), /durable ledger/u);
  await engine.dispose();
});

test("RuntimeServer 透传同批 Tool 混合结果并允许模型恢复", async () => {
  const { serverConn, clientConn } = memoryPair();
  let modelCalls = 0;
  let recoveryPrompt = "";
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return step([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "server-ok",
            toolName: "ok-agent__read",
            input: JSON.stringify({ q: "one" }),
          },
          {
            type: "tool-call",
            toolCallId: "server-fail",
            toolName: "fail-agent__read",
            input: JSON.stringify({ q: "two" }),
          },
          { type: "finish", usage: usage(), finishReason: TOOL_CALLS },
        ]);
      }
      recoveryPrompt = JSON.stringify(options.prompt);
      return step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "server recovered" },
        { type: "text-end", id: "t" },
        { type: "finish", usage: usage(), finishReason: STOP },
      ]);
    },
  });
  const engine = new ConversationEngine({
    config,
    model,
    sources: [source("ok-agent", "read"), failingSource("fail-agent", "read", "server boom")],
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

  const created = (await request(1, RpcMethod.Create, {})) as { readonly sessionId: string };
  const sent = (await request(2, RpcMethod.Send, {
    sessionId: created.sessionId,
    input: "mixed tools",
  })) as { readonly status: string };

  assert.equal(sent.status, "completed");
  assert.equal(modelCalls, 2);
  const outcomes = new Map(
    events
      .filter(
        (event): event is Extract<SessionEvent, { type: "tool-result" }> =>
          event.type === "tool-result",
      )
      .map((event) => [event.toolCallId, event.outcome?.kind]),
  );
  assert.equal(outcomes.get("server-ok"), "success");
  assert.equal(outcomes.get("server-fail"), "tool_failed");
  assert.match(recoveryPrompt, /result-ok/u);
  assert.match(recoveryPrompt, /server boom/u);
  assert.ok(
    events.some((event) => event.type === "message-finish" && event.text === "server recovered"),
  );
  await engine.dispose();
});

test("RuntimeServer 透传执行中 batch cancel，并允许同 session 下一轮恢复", async () => {
  const { serverConn, clientConn } = memoryPair();
  const allToolsStarted = Promise.withResolvers<void>();
  let startedTools = 0;
  let modelCalls = 0;
  const onStart = (): void => {
    startedTools += 1;
    if (startedTools === 2) {
      allToolsStarted.resolve();
    }
  };
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return modelCalls === 1
        ? step([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "server-slow-a",
              toolName: "slow-a__wait",
              input: JSON.stringify({ q: "one" }),
            },
            {
              type: "tool-call",
              toolCallId: "server-slow-b",
              toolName: "slow-b__wait",
              input: JSON.stringify({ q: "two" }),
            },
            { type: "finish", usage: usage(), finishReason: TOOL_CALLS },
          ])
        : step([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "server resumed" },
            { type: "text-end", id: "t" },
            { type: "finish", usage: usage(), finishReason: STOP },
          ]);
    },
  });
  const engine = new ConversationEngine({
    config,
    model,
    sources: [
      abortableSource("slow-a", "wait", onStart),
      abortableSource("slow-b", "wait", onStart),
    ],
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

  const created = (await request(1, RpcMethod.Create, {})) as { readonly sessionId: string };
  const firstTurn = request(2, RpcMethod.Send, {
    sessionId: created.sessionId,
    input: "run cancellable batch",
  });
  await allToolsStarted.promise;
  const aborted = (await request(3, RpcMethod.Abort, {
    sessionId: created.sessionId,
  })) as { readonly cancelled: boolean };
  await firstTurn;

  assert.equal(aborted.cancelled, true);
  assert.equal(startedTools, 2);
  assert.equal(events.filter((event) => event.type === "turn-cancelled").length, 1);
  assert.equal(
    events.some((event) => event.type === "message-finish"),
    false,
  );
  const ledger = (await request(4, RpcMethod.ToolExecutions, {
    sessionId: created.sessionId,
  })) as {
    readonly records: ReadonlyArray<{
      readonly toolCallId: string;
      readonly outcome: { readonly kind: string };
    }>;
  };
  assert.deepEqual(
    ledger.records.map((record) => [record.toolCallId, record.outcome.kind]).sort(),
    [
      ["server-slow-a", "cancelled"],
      ["server-slow-b", "cancelled"],
    ],
  );

  await request(5, RpcMethod.Send, {
    sessionId: created.sessionId,
    input: "continue",
  });
  assert.equal(modelCalls, 2);
  assert.ok(
    events.some((event) => event.type === "message-finish" && event.text === "server resumed"),
  );
  await engine.dispose();
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

test("RuntimeServer send 复用中央 overflow 重放且仅持久化一组当前 Turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-runtime-overflow-"));
  try {
    const { serverConn, clientConn } = memoryPair();
    const overflowConfig = rollConfigSchema.parse({
      llm: { defaultProvider: "mock", defaultModel: "mock", providers: {} },
      ask: {},
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
      agents: { dataDir: join(dir, "agents") },
    });
    const steps: readonly LanguageModelV4StreamPart[][] = [
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "seed one" },
        { type: "text-end", id: "t1" },
        { type: "finish", usage: usage(), finishReason: STOP },
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t2" },
        { type: "text-delta", id: "t2", delta: "seed two" },
        { type: "text-end", id: "t2" },
        { type: "finish", usage: usage(), finishReason: STOP },
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "error", error: "context_length_exceeded" },
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t3" },
        { type: "text-delta", id: "t3", delta: "server recovered once" },
        { type: "text-end", id: "t3" },
        { type: "finish", usage: usage(), finishReason: STOP },
      ],
    ];
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const chunks = steps[modelCalls] ?? steps.at(-1) ?? [];
        modelCalls += 1;
        return step([...chunks]);
      },
    });
    const store = new ThreadStore(join(dir, "threads"));
    const engine = new ConversationEngine({
      config: overflowConfig,
      model,
      sources: [],
      store,
      skillLibrary: null,
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
    await request(2, RpcMethod.Send, { sessionId: created.sessionId, input: "seed turn one" });
    await request(3, RpcMethod.Send, { sessionId: created.sessionId, input: "seed turn two" });
    events.length = 0;
    const recovered = (await request(4, RpcMethod.Send, {
      sessionId: created.sessionId,
      input: "server overflow current turn",
    })) as { status: string };

    assert.equal(recovered.status, "completed");
    assert.equal(modelCalls, 4);
    assert.equal(events.filter((event) => event.type === "message-start").length, 1);
    assert.equal(events.filter((event) => event.type === "context-compacted").length, 1);
    assert.equal(events.filter((event) => event.type === "message-finish").length, 1);
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );
    const messages = store.getMessages(created.sessionId);
    assert.equal(
      messages.filter(
        (message) => message.role === "user" && message.content === "server overflow current turn",
      ).length,
      1,
    );
    assert.equal(
      messages.filter(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.content).includes("server recovered once"),
      ).length,
      1,
    );

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const closeStarted = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  const createSession = engine.createSession.bind(engine);
  engine.createSession = async (input) => {
    const session = await createSession(input);
    const close = session.close.bind(session);
    session.close = async () => {
      closeStarted.resolve();
      await releaseClose.promise;
      await close();
    };
    return session;
  };
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
  let closeResponseSettled = false;
  const closing = request(2, RpcMethod.Close, {
    sessionId: created.sessionId,
  });
  closing.then(
    () => {
      closeResponseSettled = true;
    },
    () => {
      closeResponseSettled = true;
    },
  );
  await closeStarted.promise;
  await Promise.resolve();
  assert.equal(closeResponseSettled, false);

  releaseClose.resolve();
  const closed = (await closing) as { closed: boolean };
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

test("RuntimeServer.abortAll 等待所有 session close 完成", async () => {
  const { serverConn, clientConn } = memoryPair();
  const engine = new ConversationEngine({
    config,
    model: sequencedModel([[]]),
    sources: [],
  });
  const closeStarted = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  let closeStartedCount = 0;
  const createSession = engine.createSession.bind(engine);
  engine.createSession = async (input) => {
    const session = await createSession(input);
    const close = session.close.bind(session);
    session.close = async () => {
      closeStartedCount += 1;
      if (closeStartedCount === 2) {
        closeStarted.resolve();
      }
      await releaseClose.promise;
      await close();
    };
    return session;
  };
  const server = new RuntimeServer(engine, serverConn);

  const responses = new Map<number, (result: unknown) => void>();
  clientConn.onMessage((message) => {
    if ("id" in message && "result" in message && typeof message.id === "number") {
      responses.get(message.id)?.(message.result);
    }
  });
  const request = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      responses.set(id, resolve);
      clientConn.send({ jsonrpc: "2.0", id, method, params });
    });

  await request(1, RpcMethod.Create, {});
  await request(2, RpcMethod.Create, {});
  let abortAllSettled = false;
  const aborting = server.abortAll();
  aborting.then(
    () => {
      abortAllSettled = true;
    },
    () => {
      abortAllSettled = true;
    },
  );
  await closeStarted.promise;
  await Promise.resolve();
  assert.equal(abortAllSettled, false);
  assert.equal(closeStartedCount, 2);

  releaseClose.resolve();
  await aborting;
  assert.equal(abortAllSettled, true);
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
