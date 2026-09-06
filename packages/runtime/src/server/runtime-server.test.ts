import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  RUNTIME_SERVER_REQUEST_METHODS,
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES,
  RUNTIME_V13_MIN_CLIENT_FRAME_BYTES,
  approvalIdSchema,
  interactionIdSchema,
  requestIdSchema,
  streamIdSchema,
  threadIdSchema,
  turnIdSchema,
  type ApprovalRequestParams,
  type ApprovalRequestParamsV12,
  type PendingInteractionProjection,
  type RuntimeEventEnvelope,
  type RuntimeEventEnvelopeV14,
  type RuntimeServerRequestInputForSupportedVersions,
  type RuntimeServerRequestMethod,
  type UserInputRequestParamsV12,
} from "@roll-agent/protocol";
import { rollConfigSchema } from "@roll-agent/core/config/schema";
import { ConversationEngine } from "../engine/conversation-engine.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import { RuntimeService } from "../service/runtime-service.ts";
import { ThreadStore } from "../store/thread-store.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import type { SessionEvent } from "../types/events.ts";
import {
  RuntimeClientRequestCoordinator,
  RuntimeClientRequestError,
  type RuntimeClientRequest,
  type RuntimeClientRequestOptions,
  type RuntimeClientResponder,
  type RuntimeClientResponderOptions,
} from "./runtime-client-request-coordinator.ts";
import { RuntimeServer } from "./runtime-server.ts";
import {
  EVENT_NOTIFICATION,
  RpcMethod,
  isRequest,
  type JsonRpcConnection,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
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

function source(
  agentName: string,
  toolName: string,
  onToolCall: (() => void) | undefined = undefined,
): AgentToolSource {
  const secret = "runtime-server-secret";
  const client = {
    callTool: async () => {
      onToolCall?.();
      return { content: [{ type: "text", text: "result-ok" }] };
    },
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

test("RuntimeServer closes on success-response write failure without sending a false error", async () => {
  let receive: ((message: JsonRpcMessage) => void) | undefined;
  let createCalls = 0;
  let closeCalls = 0;
  const sent: JsonRpcMessage[] = [];
  const engine = {
    async createSession() {
      createCalls += 1;
      return {
        id: "00000000-0000-4000-8000-000000000299",
        async close() {},
      };
    },
  } as unknown as ConversationEngine;
  const connection: JsonRpcConnection = {
    send(message) {
      sent.push(message);
      if ("id" in message && message.id === 1 && "result" in message) {
        throw new Error("transport write failed");
      }
    },
    onMessage(listener) {
      receive = listener;
    },
    onClose() {},
    close() {
      closeCalls += 1;
    },
  };
  const server = new RuntimeServer(engine, connection);
  assert.ok(receive !== undefined);

  receive({
    jsonrpc: "2.0",
    id: 1,
    method: RpcMethod.Create,
    params: {},
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(createCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(sent.length, 1);
  assert.ok("result" in (sent[0] ?? {}));
  await server.abortAll();
});

async function waitForValue<T>(read: () => T | undefined, message: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

class SynchronouslyFailingRuntimeClientRequestCoordinator extends RuntimeClientRequestCoordinator {
  override request<TMethod extends RuntimeServerRequestMethod>(
    _method: TMethod,
    _params: RuntimeServerRequestInputForSupportedVersions<TMethod>,
    _options: RuntimeClientRequestOptions,
  ): RuntimeClientRequest<TMethod> {
    throw new RuntimeClientRequestError("synchronous request setup failure");
  }
}

class DetachWrappingRuntimeClientRequestCoordinator extends RuntimeClientRequestCoordinator {
  override attachResponder(
    responder: RuntimeClientResponder,
    options: RuntimeClientResponderOptions = {},
  ): () => void {
    const detachResponder = super.attachResponder(responder, options);
    return () => detachResponder();
  }
}

class ResponderCapturingRuntimeClientRequestCoordinator extends RuntimeClientRequestCoordinator {
  attachedResponder: RuntimeClientResponder | undefined;

  override attachResponder(
    responder: RuntimeClientResponder,
    options: RuntimeClientResponderOptions = {},
  ): () => void {
    this.attachedResponder = responder;
    return super.attachResponder(responder, options);
  }
}

function createApprovalProtocolHarness(
  onToolCall: (() => void) | undefined = undefined,
  turnTimeoutMs: number | undefined = undefined,
  runtimeClientRequests: RuntimeClientRequestCoordinator | undefined = undefined,
  configureServerConnection: ((connection: JsonRpcConnection) => void) | undefined = undefined,
) {
  const { serverConn, clientConn } = memoryPair();
  configureServerConnection?.(serverConn);
  const storeDir = mkdtempSync(join(tmpdir(), "roll-runtime-approval-v11-"));
  const store = new ThreadStore(storeDir);
  const engine = new ConversationEngine({
    config:
      turnTimeoutMs === undefined
        ? config
        : {
            ...config,
            runtime: {
              ...config.runtime,
              turnTimeoutMs,
            },
          },
    model: sequencedModel([
      [
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "approval-call",
          toolName: "approval-agent__write",
          input: JSON.stringify({ q: "requires approval" }),
        },
        { type: "finish", usage: usage(), finishReason: TOOL_CALLS },
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "approval-result" },
        { type: "text-delta", id: "approval-result", delta: "completed" },
        { type: "text-end", id: "approval-result" },
        { type: "finish", usage: usage(), finishReason: STOP },
      ],
    ]),
    sources: [source("approval-agent", "write", onToolCall)],
    policy: new DefaultToolPolicy(),
    store,
  });
  const service = new RuntimeService(engine, store, { runtimeVersion: "v1.1-test" });
  const server = new RuntimeServer(engine, serverConn, {
    runtimeService: service,
    ...(runtimeClientRequests !== undefined ? { runtimeClientRequests } : {}),
  });
  serverConn.onClose(() => {
    server.abortAll().catch(() => {});
  });
  return {
    clientConn,
    engine,
    server,
    service,
    store,
    storeDir,
    async close() {
      await server.abortAll();
      await engine.dispose();
      store.close();
      rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

function createUserInputProtocolHarness(turnTimeoutMs: number | undefined = undefined) {
  const { serverConn, clientConn } = memoryPair();
  const storeDir = mkdtempSync(join(tmpdir(), "roll-runtime-user-input-v12-"));
  const store = new ThreadStore(storeDir);
  const engine = new ConversationEngine({
    config:
      turnTimeoutMs === undefined
        ? config
        : {
            ...config,
            runtime: {
              ...config.runtime,
              turnTimeoutMs,
            },
          },
    model: sequencedModel([
      [
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "user-input-call",
          toolName: "roll__user_input",
          input: JSON.stringify({
            title: "配置部署目标",
            controls: [
              {
                type: "choice",
                id: "region",
                label: "部署区域",
                required: true,
                multiple: false,
                options: [
                  { id: "east", label: "东区" },
                  { id: "west", label: "西区" },
                ],
              },
              {
                type: "text",
                id: "workspace",
                label: "目标 Workspace",
                required: true,
                maxLength: 120,
              },
            ],
          }),
        },
        { type: "finish", usage: usage(), finishReason: TOOL_CALLS },
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "user-input-result" },
        { type: "text-delta", id: "user-input-result", delta: "已记录部署目标" },
        { type: "text-end", id: "user-input-result" },
        { type: "finish", usage: usage(), finishReason: STOP },
      ],
    ]),
    sources: [],
    policy: new DefaultToolPolicy(),
    store,
  });
  const service = new RuntimeService(engine, store, { runtimeVersion: "v1.2-user-input-test" });
  const server = new RuntimeServer(engine, serverConn, { runtimeService: service });
  return {
    clientConn,
    server,
    async close() {
      await server.abortAll();
      await engine.dispose();
      store.close();
      rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

function attachRuntimeProtocolClient(connection: JsonRpcConnection) {
  const wire: JsonRpcMessage[] = [];
  const events: RuntimeEventEnvelope[] = [];
  const responses = new Map<number, (result: unknown) => void>();
  const errors = new Map<number, (error: unknown) => void>();
  connection.onMessage((message) => {
    wire.push(message);
    if ("method" in message && message.method === RUNTIME_EVENT_NOTIFICATION) {
      events.push(message.params as RuntimeEventEnvelope);
      return;
    }
    if ("id" in message && typeof message.id === "number" && "result" in message) {
      responses.get(message.id)?.(message.result);
      return;
    }
    if ("id" in message && typeof message.id === "number" && "error" in message) {
      errors.get(message.id)?.(message.error);
    }
  });
  return {
    wire,
    events,
    request(id: number, method: string, params: unknown): Promise<unknown> {
      return new Promise((resolve) => {
        responses.set(id, resolve);
        connection.send({ jsonrpc: "2.0", id, method, params });
      });
    },
    requestError(id: number, method: string, params: unknown): Promise<unknown> {
      return new Promise((resolve) => {
        errors.set(id, resolve);
        connection.send({ jsonrpc: "2.0", id, method, params });
      });
    },
  };
}

test("Runtime Protocol 1.2 capability revisions are ordered, idempotent and version-scoped", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  const initialized = (await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2", "1.1", "1.0"],
    client: { name: "capability-client", version: "1.2.0" },
  })) as { readonly protocolVersion: string };
  assert.equal(initialized.protocolVersion, "1.2");

  const revisionOne = {
    revision: 1,
    serverRequestMethods: [
      "future.interaction.request",
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    ],
  } as const;
  const firstAck = await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, revisionOne);
  assert.deepEqual(firstAck, {
    revision: 1,
    acceptedServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  assert.deepEqual(
    await client.request(3, RUNTIME_METHODS.clientCapabilitiesSet, revisionOne),
    firstAck,
  );
  const conflicting = (await client.requestError(4, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: ["future.interaction.request"],
  })) as { readonly data?: { readonly rollCode?: string } };
  assert.equal(conflicting.data?.rollCode, "CAPABILITY_REVISION_CONFLICT");
  assert.deepEqual(
    await client.request(5, RUNTIME_METHODS.clientCapabilitiesSet, {
      revision: 2,
      serverRequestMethods: [],
    }),
    { revision: 2, acceptedServerRequestMethods: [] },
  );
  const stale = (await client.requestError(
    6,
    RUNTIME_METHODS.clientCapabilitiesSet,
    revisionOne,
  )) as {
    readonly data?: { readonly rollCode?: string };
  };
  assert.equal(stale.data?.rollCode, "CAPABILITY_REVISION_CONFLICT");
  const replayUnavailable = (await client.requestError(7, RUNTIME_METHODS.runtimeEventsResume, {
    threadId: "00000000-0000-4000-8000-000000000290",
    afterCursor: null,
  })) as { readonly data?: { readonly rollCode?: string } };
  assert.equal(replayUnavailable.data?.rollCode, "CAPABILITY_UNAVAILABLE");

  const legacyHarness = createApprovalProtocolHarness();
  const legacy = attachRuntimeProtocolClient(legacyHarness.clientConn);
  t.after(() => legacyHarness.close());
  await legacy.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "legacy-capability-client", version: "1.1.0" },
  });
  const unavailable = (await legacy.requestError(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [],
  })) as { readonly data?: { readonly rollCode?: string } };
  assert.equal(unavailable.data?.rollCode, "CAPABILITY_UNAVAILABLE");
});

test("Runtime Protocol 1.3 recovery Snapshot is bounded and remains strict in 1.2", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.3"],
    client: { name: "bounded-recovery-client", version: "1.3.0" },
  });
  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [],
  });
  const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000289",
    title: "bounded recovery",
  })) as { readonly thread: { readonly id: string } };
  const threadId = threadIdSchema.parse(created.thread.id);
  const oversizedPart = "x".repeat(9 * 1_024 * 1_024);
  harness.store.appendMessages(threadId, [{ role: "assistant", content: oversizedPart }]);
  const pendingApproval = {
    id: approvalIdSchema.parse("00000000-0000-4000-8000-000000000288"),
    turnId: turnIdSchema.parse("00000000-0000-4000-8000-000000000287"),
    agentName: "bounded-agent",
    toolName: "bounded-tool",
    preview: { detail: oversizedPart },
  } as const;
  const internal = harness.service as unknown as {
    pendingApprovals: Map<
      string,
      {
        readonly threadId: typeof threadId;
        readonly session: { cancel(): boolean };
        readonly approval: typeof pendingApproval;
        readonly expiresAt: string;
      }
    >;
  };
  internal.pendingApprovals.set(pendingApproval.id, {
    threadId,
    session: { cancel: () => true },
    approval: pendingApproval,
    expiresAt: "2099-08-04T12:05:00.000Z",
  });
  const unbounded = {
    ...harness.service.snapshotThread({ threadId, limit: 1 }),
    pendingInteractions: [],
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(unbounded), "utf8") > RUNTIME_V13_MIN_CLIENT_FRAME_BYTES,
  );

  const recovery = (await client.request(4, RUNTIME_METHODS.threadSnapshot, {
    threadId,
    limit: 1,
    recovery: true,
  })) as {
    readonly recoveryProjection?: true;
    readonly messages: { readonly items: readonly unknown[] };
    readonly operations: { readonly items: readonly unknown[] };
    readonly pendingApprovals: readonly unknown[];
    readonly pendingInteractions: readonly unknown[];
  };
  assert.equal(recovery.recoveryProjection, true);
  assert.deepEqual(recovery.messages.items, []);
  assert.deepEqual(recovery.operations.items, []);
  assert.deepEqual(recovery.pendingApprovals, []);
  assert.deepEqual(recovery.pendingInteractions, []);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 4, result: recovery }), "utf8") <
      RUNTIME_V13_MIN_CLIENT_FRAME_BYTES,
  );

  const legacyHarness = createApprovalProtocolHarness();
  const legacy = attachRuntimeProtocolClient(legacyHarness.clientConn);
  t.after(() => legacyHarness.close());
  await legacy.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "strict-recovery-client", version: "1.2.0" },
  });
  const invalid = (await legacy.requestError(2, RUNTIME_METHODS.threadSnapshot, {
    threadId,
    limit: 1,
    recovery: true,
  })) as { readonly data?: { readonly rollCode?: string } };
  assert.equal(invalid.data?.rollCode, "INVALID_PARAMS");
});

test("Runtime Protocol 1.2 exposes user input only after ACK and keeps answers out of projections", async (t) => {
  const harness = createUserInputProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "user-input-client", version: "1.2.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000430",
    title: "User input interaction",
  })) as { readonly thread: { readonly id: string } };
  const beforeAck = (await client.request(3, RUNTIME_METHODS.threadCapabilities, {
    threadId: created.thread.id,
  })) as {
    readonly manifest: {
      readonly manifest: { readonly tools: ReadonlyArray<{ readonly role: string }> };
    };
  };
  assert.equal(
    beforeAck.manifest.manifest.tools.some((tool) => tool.role === "user-input"),
    false,
  );

  await client.request(4, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest],
  });
  const afterAck = (await client.request(5, RUNTIME_METHODS.threadCapabilities, {
    threadId: created.thread.id,
  })) as {
    readonly manifest: {
      readonly manifest: { readonly tools: ReadonlyArray<{ readonly role: string }> };
    };
  };
  assert.equal(
    afterAck.manifest.manifest.tools.some((tool) => tool.role === "user-input"),
    true,
  );

  const turnId = "00000000-0000-4000-8000-000000000431";
  await client.request(6, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000432",
    threadId: created.thread.id,
    turnId,
    input: { text: "配置部署目标" },
  });
  const userInputRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      ),
    "capability ACK 后未收到 userInput.request",
  );
  const params = userInputRequest.params as UserInputRequestParamsV12;
  assert.equal(params.threadId, created.thread.id);
  assert.equal(params.turnId, turnId);
  assert.equal(params.sensitivity, "normal");
  assert.deepEqual(
    params.controls.map((control) => control.id),
    ["region", "workspace"],
  );
  assert.notEqual(params.interactionId, userInputRequest.id);

  const waiting = (await client.request(7, RUNTIME_METHODS.threadSnapshot, {
    threadId: created.thread.id,
    limit: 100,
  })) as {
    readonly activeTurn?: { readonly status: string };
    readonly pendingInteractions: readonly PendingInteractionProjection[];
  };
  assert.equal(waiting.activeTurn?.status, "waiting-for-user");
  assert.equal(waiting.pendingInteractions.length, 1);
  assert.equal(
    waiting.pendingInteractions[0]?.method,
    RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
  );
  assert.equal(JSON.stringify(waiting).includes("product-docs"), false);

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: userInputRequest.id,
    result: {
      status: "submitted",
      values: [
        { id: "workspace", value: "product-docs" },
        { id: "region", value: "east" },
      ],
    },
  });
  await waitForValue(
    () => client.events.find((event) => event.event.type === "turn.completed"),
    "user input 提交后 Turn 未完成",
  );
  const publicWire = JSON.stringify(client.wire);
  assert.equal(publicWire.includes("product-docs"), false);
  assert.equal(publicWire.includes('"value":"east"'), false);
  const settled = (await client.request(8, RUNTIME_METHODS.threadSnapshot, {
    threadId: created.thread.id,
    limit: 100,
  })) as { readonly pendingInteractions: readonly PendingInteractionProjection[] };
  assert.deepEqual(settled.pendingInteractions, []);
});

test("Runtime Protocol 1.2 user input deadline is capped by the remaining Turn lifetime", async (t) => {
  const harness = createUserInputProtocolHarness(10_000);
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "user-input-deadline-client", version: "1.2.0" },
  });
  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest],
  });
  const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000439",
    title: "User input deadline",
  })) as { readonly thread: { readonly id: string } };
  const startedAt = Date.now();
  await client.request(4, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000440",
    threadId: created.thread.id,
    turnId: "00000000-0000-4000-8000-000000000441",
    input: { text: "在短 Turn 内配置部署目标" },
  });
  const userInputRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      ),
    "短 Turn 未收到 userInput.request",
  );
  const observedAt = Date.now();
  const params = userInputRequest.params as UserInputRequestParamsV12;
  assert.ok(Date.parse(params.expiresAt) > startedAt);
  assert.ok(Date.parse(params.expiresAt) <= observedAt + 10_100);

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: userInputRequest.id,
    result: { status: "cancelled", reason: "测试完成" },
  });
  await waitForValue(
    () => client.events.find((event) => event.event.type === "turn.completed"),
    "取消短 Turn 用户输入后未完成",
  );
});

test("Runtime Protocol 1.2 capability withdrawal cancels user input once and ignores late answers", async (t) => {
  const harness = createUserInputProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "user-input-withdrawal-client", version: "1.2.0" },
  });
  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest],
  });
  const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000433",
    title: "User input capability withdrawal",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000434";
  await client.request(4, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000435",
    threadId: created.thread.id,
    turnId,
    input: { text: "配置部署目标后撤销输入能力" },
  });
  const userInputRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      ),
    "capability 撤销前未收到 userInput.request",
  );
  const interactionId = (userInputRequest.params as UserInputRequestParamsV12).interactionId;

  await client.request(5, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 2,
    serverRequestMethods: [],
  });
  await waitForValue(
    () => client.events.find((event) => event.event.type === "turn.completed"),
    "user input capability 撤销后 Turn 未收敛",
  );
  const cancellations = client.wire.filter(
    (message) =>
      "method" in message &&
      message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION &&
      typeof message.params === "object" &&
      message.params !== null &&
      "interactionId" in message.params &&
      message.params.interactionId === interactionId,
  );
  assert.equal(cancellations.length, 1);

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: userInputRequest.id,
    result: {
      status: "submitted",
      values: [
        { id: "region", value: "west" },
        { id: "workspace", value: "late-workspace-value" },
      ],
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const snapshot = (await client.request(6, RUNTIME_METHODS.threadSnapshot, {
    threadId: created.thread.id,
    limit: 100,
  })) as {
    readonly activeTurn?: unknown;
    readonly pendingInteractions: readonly PendingInteractionProjection[];
  };
  assert.equal(snapshot.activeTurn, undefined);
  assert.deepEqual(snapshot.pendingInteractions, []);
  assert.equal(JSON.stringify(client.wire).includes("late-workspace-value"), false);
});

test("RuntimeServer.abortAll cancels a pending user input interaction once", async (t) => {
  const harness = createUserInputProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "user-input-disconnect-client", version: "1.2.0" },
  });
  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest],
  });
  const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000436",
    title: "User input disconnect",
  })) as { readonly thread: { readonly id: string } };
  await client.request(4, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000437",
    threadId: created.thread.id,
    turnId: "00000000-0000-4000-8000-000000000438",
    input: { text: "配置部署目标后断开 Runtime" },
  });
  const userInputRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      ),
    "断连测试未收到 userInput.request",
  );
  const interactionId = (userInputRequest.params as UserInputRequestParamsV12).interactionId;

  await harness.server.abortAll();
  const cancellations = client.wire.filter(
    (message) =>
      "method" in message &&
      message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION &&
      typeof message.params === "object" &&
      message.params !== null &&
      "interactionId" in message.params &&
      message.params.interactionId === interactionId,
  );
  assert.equal(cancellations.length, 1);
  assert.equal(
    client.events.some((event) => event.event.type === "tool.completed"),
    false,
  );

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: userInputRequest.id,
    result: {
      status: "submitted",
      values: [
        { id: "region", value: "east" },
        { id: "workspace", value: "late-disconnected-value" },
      ],
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(client.wire).includes("late-disconnected-value"), false);
});

test("Runtime Protocol 1.2 ACK precedes Interaction delivery and uses distinct IDs", async (t) => {
  let executionCount = 0;
  const harness = createApprovalProtocolHarness(() => {
    executionCount += 1;
  });
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "interaction-client", version: "1.2.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000391",
    title: "v1.2 interaction",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000392";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000393",
    threadId: created.thread.id,
    turnId,
    input: { text: "run guarded tool after capability ACK" },
  });
  await waitForValue(
    () => client.events.find((event) => event.event.type === "approval.required"),
    "v1.2 capability ACK 前未产生 approval view",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    client.wire.some(
      (message) =>
        isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    ),
    false,
  );

  await client.request(4, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "v1.2 capability ACK 后未收到 approval.request",
  );
  const capabilityAckIndex = client.wire.findIndex(
    (message) => "id" in message && message.id === 4 && "result" in message,
  );
  assert.ok(capabilityAckIndex >= 0);
  assert.ok(capabilityAckIndex < client.wire.indexOf(approvalRequest));
  const params = approvalRequest.params as ApprovalRequestParamsV12;
  assert.equal(params.threadId, created.thread.id);
  assert.equal(params.turnId, turnId);
  assert.equal(params.approval.turnId, turnId);
  assert.equal(params.sensitivity, "normal");
  assert.match(params.interactionId, /^[0-9a-f-]{36}$/u);
  assert.ok(Date.parse(params.expiresAt) > Date.now());
  assert.notEqual(params.interactionId, approvalRequest.id);

  const expectedPendingInteraction = {
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    interactionId: params.interactionId,
    threadId: threadIdSchema.parse(created.thread.id),
    turnId: turnIdSchema.parse(turnId),
    expiresAt: params.expiresAt,
    sensitivity: "normal",
    approvalId: params.approval.id,
  } as const satisfies PendingInteractionProjection;
  const waitingSnapshot = (await client.request(5, RUNTIME_METHODS.threadSnapshot, {
    threadId: created.thread.id,
    limit: 100,
  })) as { readonly pendingInteractions: readonly PendingInteractionProjection[] };
  assert.deepEqual(waitingSnapshot.pendingInteractions, [expectedPendingInteraction]);
  const projectedInteraction = waitingSnapshot.pendingInteractions[0];
  assert.ok(projectedInteraction);
  assert.deepEqual(Object.keys(projectedInteraction).sort(), [
    "approvalId",
    "expiresAt",
    "interactionId",
    "method",
    "sensitivity",
    "threadId",
    "turnId",
  ]);
  for (const forbidden of ["id", "preview", "payload", "result"] as const) {
    assert.equal(forbidden in projectedInteraction, false);
  }
  const openedSnapshot = (await client.request(6, RUNTIME_METHODS.threadOpen, {
    threadId: created.thread.id,
  })) as { readonly pendingInteractions: readonly PendingInteractionProjection[] };
  assert.deepEqual(openedSnapshot.pendingInteractions, [expectedPendingInteraction]);

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });
  await waitForValue(
    () => client.events.find((event) => event.event.type === "turn.completed"),
    "v1.2 approval 后 Turn 未完成",
  );
  assert.equal(executionCount, 1);
  const settledSnapshot = (await client.request(7, RUNTIME_METHODS.threadSnapshot, {
    threadId: created.thread.id,
    limit: 100,
  })) as { readonly pendingInteractions: readonly PendingInteractionProjection[] };
  assert.deepEqual(settledSnapshot.pendingInteractions, []);
});

test("Runtime Protocol 1.2 capability ACK frame precedes an Interaction created inside the ACK window", async (t) => {
  const coordinator = new ResponderCapturingRuntimeClientRequestCoordinator();
  const harness = createApprovalProtocolHarness(undefined, undefined, coordinator);
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "ack-window-client", version: "1.2.0" },
  });

  const raceTurnId = turnIdSchema.parse("00000000-0000-4000-8000-0000000009ac");
  const raceApprovalId = approvalIdSchema.parse("00000000-0000-4000-8000-0000000009ad");
  const raceExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const raceParams = {
    interactionId: interactionIdSchema.parse("00000000-0000-4000-8000-0000000009aa"),
    threadId: threadIdSchema.parse("00000000-0000-4000-8000-0000000009ab"),
    turnId: raceTurnId,
    expiresAt: raceExpiresAt,
    sensitivity: "normal",
    approval: {
      id: raceApprovalId,
      turnId: raceTurnId,
      agentName: "race-agent",
      toolName: "write",
      preview: { q: "race" },
    },
  } as const;
  let raceRequest: RuntimeClientRequest<"approval.request"> | undefined;
  const originalSetUserInputAvailable = harness.service.setUserInputAvailable.bind(harness.service);
  Object.defineProperty(harness.service, "setUserInputAvailable", {
    value: (available: boolean) => {
      originalSetUserInputAvailable(available);
      const responder = coordinator.attachedResponder;
      if (raceRequest !== undefined || responder === undefined) {
        return;
      }
      raceRequest = coordinator.request(
        RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
        raceParams,
        {
          key: "race-approval",
          scopeId: responder.scopeId,
          eligibleResponderId: responder.id,
          approvalId: raceApprovalId,
          expiresAt: raceExpiresAt,
          protocolVersion: "1.2",
        },
      );
    },
  });

  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  assert.ok(raceRequest);
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "capability commit 后未投递 ACK 窗口内新建的 approval.request",
  );
  const capabilityAckIndex = client.wire.findIndex(
    (message) => "id" in message && message.id === 2 && "result" in message,
  );
  assert.ok(capabilityAckIndex >= 0);
  assert.ok(capabilityAckIndex < client.wire.indexOf(approvalRequest));

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });
  assert.deepEqual(await raceRequest.result, { decision: "approve" });
});

test("Runtime Protocol 1.2 fails approval closed when its absolute deadline is missing", async (t) => {
  let executionCount = 0;
  let deadlineLookups = 0;
  const harness = createApprovalProtocolHarness(() => {
    executionCount += 1;
  });
  Object.defineProperty(harness.service, "getPendingApprovalExpiresAt", {
    configurable: true,
    value: () => {
      deadlineLookups += 1;
      return undefined;
    },
  });
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "missing-deadline-client", version: "1.2.0" },
  });
  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000397",
    title: "missing interaction deadline",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000398";
  await client.request(4, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000399",
    threadId: created.thread.id,
    turnId,
    input: { text: "fail closed without an absolute deadline" },
  });

  const resolved = await waitForValue(
    () => client.events.find((event) => event.event.type === "approval.resolved"),
    "缺少 deadline 后 approval 未 fail-closed",
  );
  assert.equal(deadlineLookups, 1);
  assert.equal(
    client.wire.some(
      (message) =>
        isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    ),
    false,
  );
  assert.ok(resolved.event.type === "approval.resolved");
  assert.deepEqual(resolved.event.resolution, {
    status: "cancelled",
    reason: "客户端未完成审批请求，Runtime 已终止当前 Turn",
  });
  await waitForValue(
    () =>
      client.events.find((event) => event.turnId === turnId && event.event.type === "turn.failed"),
    "缺少 deadline 后 Turn 未进入失败终态",
  );
  assert.equal(executionCount, 0);
  const snapshot = (await client.request(5, RUNTIME_METHODS.threadSnapshot, {
    threadId: created.thread.id,
    limit: 100,
  })) as { readonly pendingInteractions: readonly PendingInteractionProjection[] };
  assert.deepEqual(snapshot.pendingInteractions, []);
});

test("Runtime Protocol 1.2 capability withdrawal cancels the pending Interaction once", async (t) => {
  let executionCount = 0;
  const harness = createApprovalProtocolHarness(() => {
    executionCount += 1;
  });
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "withdraw-client", version: "1.2.0" },
  });
  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000394",
    title: "withdraw interaction",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000395";
  await client.request(4, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000396",
    threadId: created.thread.id,
    turnId,
    input: { text: "withdraw while approval is pending" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "撤销测试未收到 v1.2 approval.request",
  );
  const params = approvalRequest.params as ApprovalRequestParamsV12;
  await client.request(5, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 2,
    serverRequestMethods: [],
  });
  const cancellation = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcNotification =>
          isNotification(message) && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
      ),
    "撤销 capability 后未收到 v1.2 cancel",
  );
  assert.deepEqual(cancellation.params, {
    interactionId: params.interactionId,
    reason: "Runtime 客户端已在 capability revision 2 撤销处理能力",
  });
  const resolution = await waitForValue(
    () => client.events.find((event) => event.event.type === "approval.resolved"),
    "撤销 capability 后 approval 未收口",
  );
  assert.ok(resolution.event.type === "approval.resolved");
  assert.equal(resolution.event.resolution.status, "cancelled");

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executionCount, 0);
  assert.equal(client.events.filter((event) => event.event.type === "approval.resolved").length, 1);
});

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

test("Runtime Protocol 1.3 replay 在 response barrier 后发布并发 live 且无副作用", async (t) => {
  const storeDir = mkdtempSync(join(tmpdir(), "roll-runtime-replay-v13-"));
  const store = new ThreadStore(storeDir, {
    now: () => new Date("2026-08-20T00:00:00.000Z"),
  });
  const threadId = threadIdSchema.parse("00000000-0000-4000-8000-000000000291");
  const turnId = turnIdSchema.parse("00000000-0000-4000-8000-000000000292");
  const approvalId = approvalIdSchema.parse("00000000-0000-4000-8000-000000000293");
  const liveApprovalId = approvalIdSchema.parse("00000000-0000-4000-8000-000000000295");
  const liveStreamId = streamIdSchema.parse("00000000-0000-4000-8000-000000000296");
  const largeLiveText = "x".repeat(RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES - 4_096);
  store.createThread({ id: threadId, title: "Replay" });
  store.appendRuntimeEvent({
    threadId,
    turnId,
    timestamp: "2026-08-04T12:00:00.000Z",
    event: {
      type: "approval.required",
      approval: {
        id: approvalId,
        turnId,
        agentName: "safe-agent",
        toolName: "safe-tool",
        preview: { summary: "safe projection" },
      },
    },
  });
  store.appendRuntimeEvent({
    threadId,
    turnId,
    timestamp: "2026-08-04T12:00:01.000Z",
    event: {
      type: "message.completed",
      streamId: streamIdSchema.parse("00000000-0000-4000-8000-000000000294"),
      text: "durable message",
    },
  });
  const expectedReplayThroughCursor = store.getRuntimeEventCursor(threadId);

  const engine = {
    async createSession() {
      throw new Error("not used");
    },
    async resumeSession() {
      throw new Error("not used");
    },
  } as unknown as ConversationEngine;
  const service = new RuntimeService(engine, store, { runtimeVersion: "v1.3-replay-test" });
  const liveApproval = {
    id: liveApprovalId,
    turnId,
    agentName: "live-agent",
    toolName: "live-tool",
    preview: { summary: "buffered live approval" },
  } as const;
  const internal = service as unknown as {
    pendingApprovals: Map<
      string,
      {
        readonly threadId: typeof threadId;
        readonly session: { cancel(): boolean };
        readonly approval: typeof liveApproval;
        readonly expiresAt: string;
      }
    >;
    emit(
      targetThreadId: typeof threadId,
      targetTurnId: typeof turnId,
      event:
        | { readonly type: "approval.required"; readonly approval: typeof liveApproval }
        | {
            readonly type: "message.completed";
            readonly streamId: typeof liveStreamId;
            readonly text: string;
          },
    ): void;
  };
  internal.pendingApprovals.set(liveApprovalId, {
    threadId,
    session: { cancel: () => true },
    approval: liveApproval,
    expiresAt: "2099-08-04T12:05:00.000Z",
  });
  let receive: ((message: JsonRpcMessage) => void) | undefined;
  const sent: JsonRpcMessage[] = [];
  let injectedLive = false;
  let resumeResponseSent = false;
  let approvalRequestBeforeResumeResponse = false;
  let observerCalls = 0;
  service.onEvent(() => {
    observerCalls += 1;
  });
  const connection: JsonRpcConnection = {
    send(message) {
      sent.push(message);
      if ("id" in message && message.id === 3 && "result" in message) {
        resumeResponseSent = true;
      }
      if (
        isRequest(message) &&
        message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest &&
        !resumeResponseSent
      ) {
        approvalRequestBeforeResumeResponse = true;
      }
      if (
        !injectedLive &&
        "method" in message &&
        message.method === RUNTIME_EVENT_NOTIFICATION &&
        (message.params as RuntimeEventEnvelopeV14).event.type === "approval.required"
      ) {
        injectedLive = true;
        internal.emit(threadId, turnId, { type: "approval.required", approval: liveApproval });
        internal.emit(threadId, turnId, {
          type: "message.completed",
          streamId: liveStreamId,
          text: largeLiveText,
        });
      }
    },
    onMessage(listener) {
      receive = listener;
    },
    onClose() {},
    close() {},
  };
  const server = new RuntimeServer(engine, connection, { runtimeService: service });
  t.after(async () => {
    await server.abortAll();
    store.close();
    rmSync(storeDir, { recursive: true, force: true });
  });
  assert.ok(receive !== undefined);
  const request = async (id: number, method: string, params: unknown): Promise<JsonRpcMessage> => {
    receive?.({ jsonrpc: "2.0", id, method, params });
    return waitForValue(
      () => sent.find((message) => "id" in message && message.id === id),
      `missing response for ${method}`,
    );
  };

  await request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.3", "1.2", "1.1", "1.0"],
    client: { name: "replay-client", version: "1.3.0" },
  });
  await request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  sent.length = 0;

  const response = await request(3, RUNTIME_METHODS.runtimeEventsResume, {
    threadId,
    afterCursor: null,
  });
  assert.ok("result" in response);
  assert.deepEqual(response.result, {
    throughCursor: expectedReplayThroughCursor,
    replayedCount: 2,
  });
  assert.deepEqual(
    sent.map((message) => {
      if ("method" in message && message.method === RUNTIME_EVENT_NOTIFICATION) {
        return (message.params as RuntimeEventEnvelopeV14).event.type;
      }
      if ("id" in message && message.id === 3) {
        return "resume.response";
      }
      if (
        "method" in message &&
        message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
      ) {
        return "approval.request";
      }
      return "unexpected";
    }),
    [
      "approval.required",
      "message.completed",
      "resume.response",
      "approval.request",
      "approval.required",
      "message.completed",
    ],
  );
  assert.equal(
    sent.filter(
      (message) =>
        "method" in message && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    ).length,
    1,
  );
  assert.equal(approvalRequestBeforeResumeResponse, false);
  const liveApprovalRequest = sent.find(
    (message): message is JsonRpcRequest =>
      isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
  );
  assert.ok(liveApprovalRequest);
  assert.equal(
    (liveApprovalRequest.params as ApprovalRequestParamsV12).approval.id,
    liveApprovalId,
  );
  const largeLiveEvent = sent.find(
    (message): message is JsonRpcNotification =>
      "method" in message &&
      !("id" in message) &&
      message.method === RUNTIME_EVENT_NOTIFICATION &&
      (() => {
        const event = (message.params as RuntimeEventEnvelopeV14).event;
        return event.type === "message.completed" && event.text.length === largeLiveText.length;
      })(),
  );
  assert.ok(largeLiveEvent);
  const largeLiveEnvelope = largeLiveEvent.params as RuntimeEventEnvelopeV14;
  assert.equal(largeLiveEnvelope.event.type, "message.completed");
  if (largeLiveEnvelope.event.type === "message.completed") {
    assert.equal(largeLiveEnvelope.event.text.length, largeLiveText.length);
  }
  assert.equal(observerCalls, 2);

  sent.length = 0;
  const gap = await request(4, RUNTIME_METHODS.runtimeEventsResume, {
    threadId,
    afterCursor: "rte1:00000000-0000-4000-8000-000000000299:0:00000000-0000-4000-8000-000000000298",
  });
  assert.ok("error" in gap);
  assert.equal(gap.error.data?.rollCode, "EVENT_CURSOR_GAP");
});

test("RuntimeServer 每条连接只能选择 Runtime Protocol 或 legacy session RPC", async (t) => {
  const { serverConn, clientConn } = memoryPair();
  const storeDir = mkdtempSync(join(tmpdir(), "roll-runtime-v1-server-"));
  const store = new ThreadStore(storeDir);
  const engine = new ConversationEngine({
    config,
    model: sequencedModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "protocol response" },
        { type: "text-end", id: "t" },
        { type: "finish", usage: usage(), finishReason: STOP },
      ],
    ]),
    sources: [],
    store,
  });
  const service = new RuntimeService(engine, store, { runtimeVersion: "0.9.0-test" });
  const server = new RuntimeServer(engine, serverConn, { runtimeService: service });
  t.after(async () => {
    await server.abortAll();
    await engine.dispose();
    store.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  const responses = new Map<number, (result: unknown) => void>();
  const errors = new Map<number, (error: unknown) => void>();
  const events: RuntimeEventEnvelope[] = [];
  clientConn.onMessage((message) => {
    if ("method" in message && message.method === RUNTIME_EVENT_NOTIFICATION) {
      events.push(message.params as RuntimeEventEnvelope);
    } else if ("id" in message && "result" in message && typeof message.id === "number") {
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
  const requestError = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      errors.set(id, resolve);
      clientConn.send({ jsonrpc: "2.0", id, method, params });
    });

  const initializeRequired = await requestError(1, RUNTIME_METHODS.threadList, { limit: 10 });
  assert.deepEqual(initializeRequired, {
    code: -32_000,
    message: "调用 Runtime Protocol 方法前必须先完成 initialize",
    data: { rollCode: "INITIALIZE_REQUIRED", retryable: false },
  });

  const initialized = (await request(2, RUNTIME_METHODS.initialize, {
    protocolVersions: [RUNTIME_PROTOCOL_VERSION],
    client: { name: "runtime-server-test", version: "1.0.0" },
  })) as { readonly protocolVersion: string; readonly runtimeInstanceId: string };
  assert.equal(initialized.protocolVersion, RUNTIME_PROTOCOL_VERSION);
  assert.match(initialized.runtimeInstanceId, /^[0-9a-f-]{36}$/u);

  const created = (await request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000201",
    title: "Protocol thread",
  })) as { readonly thread: { readonly id: string } };
  const turnCompleted = Promise.withResolvers<void>();
  clientConn.onMessage((message) => {
    if (
      "method" in message &&
      message.method === RUNTIME_EVENT_NOTIFICATION &&
      (message.params as RuntimeEventEnvelope).event.type === "turn.completed"
    ) {
      turnCompleted.resolve();
    }
  });
  const started = (await request(4, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000202",
    threadId: created.thread.id,
    turnId: "00000000-0000-4000-8000-000000000203",
    input: { text: "hello" },
  })) as { readonly accepted: boolean };
  assert.equal(started.accepted, true);
  await turnCompleted.promise;
  assert.equal(
    events.some((event) => event.event.type === "message.delta"),
    true,
  );

  const snapshot = (await request(5, RUNTIME_METHODS.threadSnapshot, {
    threadId: created.thread.id,
    limit: 100,
  })) as { readonly messages: { readonly items: readonly unknown[] } };
  assert.equal(snapshot.messages.items.length, 2);

  const legacyError = (await requestError(6, RpcMethod.Create, {})) as {
    readonly data?: { readonly rollCode?: string };
  };
  assert.equal(legacyError.data?.rollCode, "CAPABILITY_UNAVAILABLE");

  const legacyPair = memoryPair();
  const legacyRuntimeService = new RuntimeService(engine, store, {
    runtimeVersion: "0.9.0-test",
  });
  const legacyServer = new RuntimeServer(engine, legacyPair.serverConn, {
    runtimeService: legacyRuntimeService,
  });
  t.after(() => legacyServer.abortAll());
  const legacyResponses = new Map<number, (result: unknown) => void>();
  const legacyErrors = new Map<number, (error: unknown) => void>();
  legacyPair.clientConn.onMessage((message) => {
    if ("id" in message && typeof message.id === "number" && "result" in message) {
      legacyResponses.get(message.id)?.(message.result);
    } else if ("id" in message && typeof message.id === "number" && "error" in message) {
      legacyErrors.get(message.id)?.(message.error);
    }
  });
  const legacyRequest = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      legacyResponses.set(id, resolve);
      legacyPair.clientConn.send({ jsonrpc: "2.0", id, method, params });
    });
  const legacyRequestError = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      legacyErrors.set(id, resolve);
      legacyPair.clientConn.send({ jsonrpc: "2.0", id, method, params });
    });
  const legacy = (await legacyRequest(1, RpcMethod.Create, {})) as {
    readonly sessionId: string;
  };
  assert.match(legacy.sessionId, /^[0-9a-f-]{36}$/u);
  const initializeError = (await legacyRequestError(2, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1", "1.0"],
    client: { name: "mixed-client", version: "1.0.0" },
  })) as { readonly data?: { readonly rollCode?: string } };
  assert.equal(initializeError.data?.rollCode, "CAPABILITY_UNAVAILABLE");
});

test("一个 RuntimeService 同时只接受一个 Runtime Protocol 控制连接", async (t) => {
  const harness = createApprovalProtocolHarness();
  const primaryClient = attachRuntimeProtocolClient(harness.clientConn);
  const competingPair = memoryPair();
  t.after(() => harness.close());

  assert.throws(
    () =>
      new RuntimeServer(harness.engine, competingPair.serverConn, {
        runtimeService: harness.service,
      }),
    /已绑定 Runtime Protocol Adapter/u,
  );

  await primaryClient.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1", "1.0"],
    client: { name: "primary-controller", version: "1.1.0" },
  });
  const threads = (await primaryClient.request(2, RUNTIME_METHODS.threadList, {
    limit: 10,
  })) as { readonly items: readonly unknown[] };
  assert.deepEqual(threads.items, []);

  const originalServiceClose = harness.service.close.bind(harness.service);
  let notifyCloseStarted: () => void = () => {};
  const closeStarted = new Promise<void>((resolve) => {
    notifyCloseStarted = resolve;
  });
  let releaseServiceClose: () => void = () => {};
  const serviceCloseGate = new Promise<void>((resolve) => {
    releaseServiceClose = resolve;
  });
  let serviceCloseCalls = 0;
  harness.service.close = async () => {
    serviceCloseCalls += 1;
    if (serviceCloseCalls > 1) {
      return;
    }
    notifyCloseStarted();
    await serviceCloseGate;
    await originalServiceClose();
  };

  const closing = harness.server.abortAll();
  await closeStarted;
  let concurrentCloseSettled = false;
  const concurrentClosing = harness.server.abortAll().then(() => {
    concurrentCloseSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(concurrentCloseSettled, false);
  assert.throws(
    () =>
      new RuntimeServer(harness.engine, competingPair.serverConn, {
        runtimeService: harness.service,
      }),
    /已绑定 Runtime Protocol Adapter/u,
  );
  releaseServiceClose();
  await Promise.all([closing, concurrentClosing]);
  assert.equal(serviceCloseCalls, 1);

  const replacementPair = memoryPair();
  const replacement = new RuntimeServer(harness.engine, replacementPair.serverConn, {
    runtimeService: harness.service,
  });
  await replacement.abortAll();
});

test("Runtime Protocol 控制租约在构造失败后回滚", async (t) => {
  const harness = createApprovalProtocolHarness();
  t.after(() => harness.close());
  await harness.server.abortAll();

  const originalOnEvent = harness.service.onEvent.bind(harness.service);
  harness.service.onEvent = () => {
    throw new Error("event subscription failed");
  };
  const eventPair = memoryPair();
  assert.throws(
    () =>
      new RuntimeServer(harness.engine, eventPair.serverConn, {
        runtimeService: harness.service,
      }),
    /event subscription failed/u,
  );
  harness.service.onEvent = originalOnEvent;

  const throwingConnection: JsonRpcConnection = {
    send() {},
    onMessage() {
      throw new Error("message subscription failed");
    },
    onClose() {},
    close() {},
  };
  assert.throws(
    () =>
      new RuntimeServer(harness.engine, throwingConnection, {
        runtimeService: harness.service,
      }),
    /message subscription failed/u,
  );

  const replacementPair = memoryPair();
  const replacement = new RuntimeServer(harness.engine, replacementPair.serverConn, {
    runtimeService: harness.service,
  });
  await replacement.abortAll();
});

test("Runtime Protocol 1.1 同步请求初始化失败时先投影 required 再投影 resolved", async (t) => {
  const harness = createApprovalProtocolHarness(
    undefined,
    undefined,
    new SynchronouslyFailingRuntimeClientRequestCoordinator(),
  );
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "sync-failure-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000390",
    title: "sync request failure",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000391";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000392",
    threadId: created.thread.id,
    turnId,
    input: { text: "trigger guarded tool" },
  });

  const resolved = await waitForValue(
    () => client.events.find((event) => event.event.type === "approval.resolved"),
    "同步请求失败后未收到 approval.resolved",
  );
  const requiredIndex = client.events.findIndex(
    (event) => event.event.type === "approval.required",
  );
  const resolvedIndex = client.events.indexOf(resolved);
  assert.ok(requiredIndex >= 0);
  assert.ok(resolvedIndex > requiredIndex);
  assert.equal(
    client.wire.some(
      (message) =>
        isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    ),
    false,
  );
  assert.ok(resolved.event.type === "approval.resolved");
  assert.deepEqual(resolved.event.resolution, {
    status: "cancelled",
    reason: "客户端未完成审批请求，Runtime 已终止当前 Turn",
  });
  await waitForValue(
    () =>
      client.events.find((event) => event.turnId === turnId && event.event.type === "turn.failed"),
    "同步请求失败后 Turn 未进入失败终态",
  );
});

test("Runtime Protocol approval.resolved 写盘失败时取消 Turn 并关闭 transport", async (t) => {
  let executionCount = 0;
  let closeCalls = 0;
  let closeHandler: (() => void) | undefined;
  const harness = createApprovalProtocolHarness(
    () => {
      executionCount += 1;
    },
    undefined,
    undefined,
    (connection) => {
      connection.onClose = (handler) => {
        closeHandler = handler;
      };
      connection.close = () => {
        closeCalls += 1;
        closeHandler?.();
      };
    },
  );
  const client = attachRuntimeProtocolClient(harness.clientConn);
  const database = new DatabaseSync(join(harness.storeDir, "threads.db"));
  t.after(async () => {
    database.close();
    await harness.close();
  });

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "failing-durable-approval", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000450",
    title: "failing durable approval",
  })) as { readonly thread: { readonly id: string } };
  const threadId = threadIdSchema.parse(created.thread.id);
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000452",
    threadId,
    turnId: "00000000-0000-4000-8000-000000000451",
    input: { text: "trigger guarded tool" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "未收到 approval.request",
  );

  database.exec(`
    CREATE TRIGGER reject_protocol_approval_resolution
    BEFORE INSERT ON runtime_events
    WHEN NEW.event_json LIKE '%"approval.resolved"%'
    BEGIN
      SELECT RAISE(ABORT, 'blocked protocol approval resolution');
    END;
  `);
  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });

  await waitForValue(() => (closeCalls === 1 ? true : undefined), "Store 失败后连接未关闭");
  await harness.server.abortAll();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(closeCalls, 1);
  assert.equal(executionCount, 0);
  assert.equal(
    client.events.some((event) => event.event.type === "approval.resolved"),
    false,
  );
  assert.equal(
    harness.store
      .resumeRuntimeEvents(threadId, null)
      .events.some((event) => event.event.type === "approval.resolved"),
    false,
  );
  const internalService = harness.service as unknown as {
    readonly pendingApprovals: ReadonlyMap<string, unknown>;
  };
  assert.equal(internalService.pendingApprovals.size, 0);
});

test("Runtime Protocol event write failure closes the transport after local settlement", async (t) => {
  let executionCount = 0;
  let closeCalls = 0;
  const harness = createApprovalProtocolHarness(
    () => {
      executionCount += 1;
    },
    undefined,
    undefined,
    (connection) => {
      const send = connection.send.bind(connection);
      connection.send = (message) => {
        if (
          "method" in message &&
          message.method === RUNTIME_EVENT_NOTIFICATION &&
          (message.params as RuntimeEventEnvelope).event.type === "approval.resolved"
        ) {
          throw new Error("event transport write failed");
        }
        send(message);
      };
      connection.close = () => {
        closeCalls += 1;
      };
    },
  );
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "throwing-event-transport", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000393",
    title: "throwing event transport",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000394";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000395",
    threadId: created.thread.id,
    turnId,
    input: { text: "trigger guarded tool" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "未收到 approval.request",
  );

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });
  await waitForValue(() => (closeCalls === 1 ? true : undefined), "event 写失败后连接未关闭");
  await waitForValue(() => (executionCount === 1 ? true : undefined), "审批决议未在本地生效");
  await waitForValue(
    () =>
      harness.service.snapshotThread({
        threadId: threadIdSchema.parse(created.thread.id),
        limit: 100,
      }).activeTurn === undefined
        ? true
        : undefined,
    "event 写失败后 Turn 未在本地收口",
  );

  assert.equal(
    client.events.some((event) => event.event.type === "approval.resolved"),
    false,
  );
  assert.deepEqual(
    harness.service.snapshotThread({
      threadId: threadIdSchema.parse(created.thread.id),
      limit: 100,
    }).pendingApprovals,
    [],
  );
});

test("Runtime Protocol required-event write failure fails the pending approval closed", async (t) => {
  let executionCount = 0;
  let closeCalls = 0;
  const harness = createApprovalProtocolHarness(
    () => {
      executionCount += 1;
    },
    undefined,
    undefined,
    (connection) => {
      const send = connection.send.bind(connection);
      connection.send = (message) => {
        if (
          "method" in message &&
          message.method === RUNTIME_EVENT_NOTIFICATION &&
          (message.params as RuntimeEventEnvelope).event.type === "approval.required"
        ) {
          throw new Error("required event transport write failed");
        }
        send(message);
      };
      connection.close = () => {
        closeCalls += 1;
      };
    },
  );
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "throwing-required-event-transport", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000396",
    title: "throwing required event transport",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000397";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000398",
    threadId: created.thread.id,
    turnId,
    input: { text: "trigger guarded tool" },
  });

  await waitForValue(() => (closeCalls === 1 ? true : undefined), "required event 写失败后未关闭");
  await waitForValue(
    () =>
      harness.service.snapshotThread({
        threadId: threadIdSchema.parse(created.thread.id),
        limit: 100,
      }).activeTurn === undefined
        ? true
        : undefined,
    "required event 写失败后 Turn 未 fail-closed",
  );

  assert.equal(executionCount, 0);
  assert.deepEqual(
    harness.service.snapshotThread({
      threadId: threadIdSchema.parse(created.thread.id),
      limit: 100,
    }).pendingApprovals,
    [],
  );
  assert.equal(
    client.wire.some(
      (message) =>
        isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    ),
    true,
  );
});

test("Runtime Protocol 1.1 以 approval.request 作为唯一审批控制路径", async (t) => {
  let executionCount = 0;
  const harness = createApprovalProtocolHarness(() => {
    executionCount += 1;
  });
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  const initialized = (await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1", "1.0"],
    client: { name: "v1.1-client", version: "1.1.0" },
  })) as { readonly protocolVersion: string };
  assert.equal(initialized.protocolVersion, "1.1");

  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000301",
    title: "v1.1 approval",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000302";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000303",
    threadId: created.thread.id,
    turnId,
    input: { text: "run guarded tool" },
  });

  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "未收到 approval.request",
  );
  const approvalView = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcNotification =>
          isNotification(message) &&
          message.method === RUNTIME_EVENT_NOTIFICATION &&
          (message.params as RuntimeEventEnvelope).event.type === "approval.required",
      ),
    "未收到 approval.required",
  );
  assert.ok(client.wire.indexOf(approvalRequest) < client.wire.indexOf(approvalView));
  const approvalParams = approvalRequest.params as ApprovalRequestParams;
  assert.deepEqual(Object.keys(approvalParams).sort(), ["approval", "threadId"]);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const waitingSnapshot = (await client.request(4, RUNTIME_METHODS.threadSnapshot, {
    threadId: created.thread.id,
    limit: 100,
  })) as {
    readonly pendingApprovals: readonly { readonly id: string }[];
    readonly pendingInteractions?: unknown;
  };
  assert.deepEqual(
    waitingSnapshot.pendingApprovals.map((approval) => approval.id),
    [approvalParams.approval.id],
  );
  assert.equal(Object.hasOwn(waitingSnapshot, "pendingInteractions"), false);

  const legacyControlError = (await client.requestError(5, RUNTIME_METHODS.approvalRespond, {
    requestId: "00000000-0000-4000-8000-000000000304",
    threadId: created.thread.id,
    turnId,
    approvalId: approvalParams.approval.id,
    decision: "approve",
  })) as { readonly data?: { readonly rollCode?: string } };
  assert.equal(legacyControlError.data?.rollCode, "CAPABILITY_UNAVAILABLE");
  const legacySessionBypassError = (await client.requestError(6, RpcMethod.Approve, {
    sessionId: created.thread.id,
    approvalId: approvalParams.approval.id,
  })) as { readonly data?: { readonly rollCode?: string } };
  assert.equal(legacySessionBypassError.data?.rollCode, "CAPABILITY_UNAVAILABLE");

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });
  const resolved = await waitForValue(
    () =>
      client.events.find(
        (envelope) =>
          envelope.event.type === "approval.resolved" &&
          envelope.event.approvalId === approvalParams.approval.id,
      ),
    "未收到 approval.resolved",
  );
  assert.deepEqual(resolved.event, {
    type: "approval.resolved",
    approvalId: approvalParams.approval.id,
    resolution: { status: "resolved", decision: "approve" },
  });
  await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "turn.completed"),
    "审批后 Turn 未完成",
  );
  const approvalRequiredIndex = client.events.findIndex(
    (envelope) => envelope.event.type === "approval.required",
  );
  const approvalResolvedIndex = client.events.indexOf(resolved);
  const toolCompletedIndex = client.events.findIndex(
    (envelope) => envelope.event.type === "tool.completed",
  );
  assert.ok(approvalRequiredIndex >= 0);
  assert.ok(approvalResolvedIndex > approvalRequiredIndex);
  assert.ok(toolCompletedIndex > approvalResolvedIndex);
  assert.deepEqual(
    client.events.map((event) => event.sequence),
    client.events.map((_event, index) => index),
  );
  assert.equal(
    client.events.every((event) => event.protocolVersion === "1.1"),
    true,
  );
  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executionCount, 1);
  assert.equal(client.events.filter((event) => event.event.type === "approval.resolved").length, 1);
});

test("Runtime Protocol 1.1 接受 Client 收到 server request 后立即返回的审批", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  harness.clientConn.onMessage((message) => {
    if (isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest) {
      harness.clientConn.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { decision: "approve" },
      });
    }
  });

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "fast-approval-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000341",
    title: "fast v1.1 approval",
  })) as { readonly thread: { readonly id: string } };
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000342",
    threadId: created.thread.id,
    turnId: "00000000-0000-4000-8000-000000000343",
    input: { text: "approve immediately" },
  });

  const terminal = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "turn.completed"),
    "立即审批后 Turn 未完成",
  );
  const requestIndex = client.wire.findIndex(
    (message) =>
      isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
  );
  const viewIndex = client.wire.findIndex(
    (message) =>
      isNotification(message) &&
      message.method === RUNTIME_EVENT_NOTIFICATION &&
      (message.params as RuntimeEventEnvelope).event.type === "approval.required",
  );
  const resolvedIndex = client.events.findIndex(
    (envelope) => envelope.event.type === "approval.resolved",
  );
  const toolCompletedIndex = client.events.findIndex(
    (envelope) => envelope.event.type === "tool.completed",
  );

  assert.ok(requestIndex >= 0);
  assert.ok(viewIndex > requestIndex);
  assert.ok(resolvedIndex >= 0);
  assert.ok(toolCompletedIndex > resolvedIndex);
  assert.equal(terminal.protocolVersion, "1.1");
});

test("Runtime Protocol 1.1 兼容注入 Coordinator 包装 responder detach closure", async (t) => {
  const harness = createApprovalProtocolHarness(
    undefined,
    undefined,
    new DetachWrappingRuntimeClientRequestCoordinator(),
  );
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  harness.clientConn.onMessage((message) => {
    if (isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest) {
      harness.clientConn.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { decision: "approve" },
      });
    }
  });

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "wrapped-detach-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000344",
    title: "wrapped detach approval",
  })) as { readonly thread: { readonly id: string } };
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000345",
    threadId: created.thread.id,
    turnId: "00000000-0000-4000-8000-000000000346",
    input: { text: "approve through wrapped detach" },
  });

  await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "turn.completed"),
    "包装 detach closure 后的审批响应未完成 Turn",
  );
});

test("Runtime Protocol 1.2 wrapped detach 仍可安全投影 pending Interaction", async (t) => {
  const harness = createApprovalProtocolHarness(
    undefined,
    undefined,
    new DetachWrappingRuntimeClientRequestCoordinator(),
  );
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.2"],
    client: { name: "wrapped-detach-v12-client", version: "1.2.0" },
  });
  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000347",
    title: "wrapped detach v1.2 interaction",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000348";
  await client.request(4, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000349",
    threadId: created.thread.id,
    turnId,
    input: { text: "project through wrapped detach" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "包装 detach closure 后未收到 v1.2 approval.request",
  );
  const params = approvalRequest.params as ApprovalRequestParamsV12;

  for (const snapshot of [
    await client.request(5, RUNTIME_METHODS.threadSnapshot, {
      threadId: created.thread.id,
      limit: 100,
    }),
    await client.request(6, RUNTIME_METHODS.threadOpen, {
      threadId: created.thread.id,
    }),
  ]) {
    const projected = snapshot as {
      readonly pendingInteractions: readonly PendingInteractionProjection[];
    };
    assert.equal(projected.pendingInteractions.length, 1);
    assert.equal(projected.pendingInteractions[0]?.interactionId, params.interactionId);
    assert.equal(projected.pendingInteractions[0]?.threadId, created.thread.id);
  }

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "reject", reason: "test complete" },
  });
  await waitForValue(
    () => client.events.find((event) => event.event.type === "turn.completed"),
    "包装 detach closure 后的 v1.2 拒绝未完成 Turn",
  );
});

test("Runtime Protocol 1.1 用户拒绝保持成功业务结果并阻止 Tool 副作用", async (t) => {
  let executionCount = 0;
  const harness = createApprovalProtocolHarness(() => {
    executionCount += 1;
  });
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "reject-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000346",
    title: "reject approval",
  })) as { readonly thread: { readonly id: string } };
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000347",
    threadId: created.thread.id,
    turnId: "00000000-0000-4000-8000-000000000348",
    input: { text: "reject guarded tool" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "拒绝测试未收到 approval.request",
  );
  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "reject", reason: "用户取消" },
  });

  const resolved = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "approval.resolved"),
    "拒绝后未收到 approval.resolved",
  );
  assert.ok(resolved.event.type === "approval.resolved");
  assert.deepEqual(resolved.event.resolution, {
    status: "resolved",
    decision: "reject",
    reason: "用户取消",
  });
  await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "turn.completed"),
    "用户拒绝后 Turn 未完成",
  );
  assert.equal(executionCount, 0);
  const tool = client.events.find((envelope) => envelope.event.type === "tool.completed");
  assert.ok(tool?.event.type === "tool.completed");
  assert.equal(tool.event.outcome?.kind, "user_rejected");
});

test("Runtime Protocol 1.1 在 response 已关联但尚未 settle 时仍先收口审批", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "response-terminal-race-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000351",
    title: "response terminal race",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000352";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000353",
    threadId: created.thread.id,
    turnId,
    input: { text: "race response with terminal" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "竞态测试未收到 approval.request",
  );
  let pendingAtResolution: readonly string[] | undefined;
  const unsubscribeSnapshotProbe = harness.service.onEvent((envelope) => {
    if (envelope.event.type !== "approval.resolved") {
      return;
    }
    pendingAtResolution = harness.service
      .snapshotThread({
        threadId: threadIdSchema.parse(created.thread.id),
        limit: 100,
      })
      .pendingApprovals.map((approval) => approval.id);
  });
  t.after(unsubscribeSnapshotProbe);

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });
  await harness.service.cancelTurn({
    requestId: requestIdSchema.parse("00000000-0000-4000-8000-000000000354"),
    threadId: threadIdSchema.parse(created.thread.id),
    turnId: turnIdSchema.parse(turnId),
  });

  const resolved = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "approval.resolved"),
    "竞态终态前未收到 approval.resolved",
  );
  const terminal = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "turn.cancelled"),
    "竞态测试未收到 turn.cancelled",
  );
  assert.ok(client.events.indexOf(resolved) < client.events.indexOf(terminal));
  assert.equal(
    client.events.filter((envelope) => envelope.event.type === "approval.resolved").length,
    1,
  );
  assert.deepEqual(pendingAtResolution, []);
  assert.equal(
    client.wire.some(
      (message) =>
        isNotification(message) && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    ),
    false,
  );
  assert.equal(
    client.events.some((envelope) => envelope.event.type === "tool.completed"),
    false,
  );

  const reopened = (await client.request(4, RUNTIME_METHODS.threadOpen, {
    threadId: created.thread.id,
  })) as { readonly thread: { readonly id: string } };
  assert.equal(reopened.thread.id, created.thread.id);
  const recoveryTurnId = "00000000-0000-4000-8000-000000000379";
  await client.request(5, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000380",
    threadId: created.thread.id,
    turnId: recoveryTurnId,
    input: { text: "continue after handler failure" },
  });
  await waitForValue(
    () =>
      client.events.find(
        (envelope) =>
          envelope.turnId === recoveryTurnId && envelope.event.type === "turn.completed",
      ),
    "handler error 后同一 Session 无法继续新 Turn",
  );
});

test("Runtime Protocol 1.1 对 id:null Client error 立即 fail-closed", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "uncorrelated-error-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000371",
    title: "uncorrelated error",
  })) as { readonly thread: { readonly id: string } };
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000372",
    threadId: created.thread.id,
    turnId: "00000000-0000-4000-8000-000000000373",
    input: { text: "fail closed on uncorrelated error" },
  });
  await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "id:null 测试未收到 approval.request",
  );

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32_700, message: "Parse error" },
  });

  const resolved = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "approval.resolved"),
    "id:null 后未收口 approval",
  );
  assert.ok(resolved.event.type === "approval.resolved");
  assert.deepEqual(resolved.event.resolution, {
    status: "cancelled",
    reason: "客户端未完成审批请求，Runtime 已终止当前 Turn",
  });
  const terminal = await waitForValue(
    () =>
      client.events.find(
        (envelope) =>
          envelope.event.type === "turn.completed" ||
          envelope.event.type === "turn.cancelled" ||
          envelope.event.type === "turn.failed",
      ),
    "id:null 后 Turn 未结束",
  );
  assert.equal(terminal.event.type, "turn.failed");
  assert.equal(
    client.events.some((envelope) => envelope.event.type === "tool.completed"),
    false,
  );
});

test("Runtime Protocol 1.1 handler error 终止 Turn 且不冒充用户拒绝", async (t) => {
  let executionCount = 0;
  const harness = createApprovalProtocolHarness(() => {
    executionCount += 1;
  });
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "missing-handler-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000376",
    title: "handler error",
  })) as { readonly thread: { readonly id: string } };
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000377",
    threadId: created.thread.id,
    turnId: "00000000-0000-4000-8000-000000000378",
    input: { text: "fail closed on missing handler" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "handler error 测试未收到 approval.request",
  );
  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    error: { code: -32_601, message: "Method not found" },
  });

  const resolved = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "approval.resolved"),
    "handler error 后未收口 approval",
  );
  assert.ok(resolved.event.type === "approval.resolved");
  assert.deepEqual(resolved.event.resolution, {
    status: "cancelled",
    reason: "客户端未完成审批请求，Runtime 已终止当前 Turn",
  });
  const terminal = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "turn.failed"),
    "handler error 后 Turn 未失败",
  );
  assert.equal(terminal.event.type, "turn.failed");
  assert.equal(executionCount, 0);
  assert.equal(
    client.events.some((envelope) => envelope.event.type === "tool.completed"),
    false,
  );
});

test("Runtime Protocol 1.0 拒绝带 scope 的 approval.respond", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.0"],
    client: { name: "v1.0-client", version: "1.0.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000411",
    title: "v1.0 reject scope",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000412";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000413",
    threadId: created.thread.id,
    turnId,
    input: { text: "run guarded tool" },
  });
  const approvalView = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "approval.required"),
    "v1.0 未收到 approval.required",
  );
  assert.ok(approvalView.event.type === "approval.required");
  const error = (await client.requestError(4, RUNTIME_METHODS.approvalRespond, {
    requestId: "00000000-0000-4000-8000-000000000414",
    threadId: created.thread.id,
    turnId,
    approvalId: approvalView.event.approval.id,
    decision: "approve",
    scope: "session",
  })) as { readonly data?: { readonly rollCode?: string }; readonly message?: string };
  assert.equal(error.data?.rollCode, "INVALID_PARAMS");
});

test("Runtime Protocol 1.0 保持 approval.required + approval.respond", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  const initialized = (await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.0"],
    client: { name: "v1.0-client", version: "1.0.0" },
  })) as { readonly protocolVersion: string };
  assert.equal(initialized.protocolVersion, "1.0");
  const renegotiationError = (await client.requestError(20, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "v1.1-client", version: "1.1.0" },
  })) as { readonly data?: { readonly rollCode?: string } };
  assert.equal(renegotiationError.data?.rollCode, "CAPABILITY_UNAVAILABLE");
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000311",
    title: "v1.0 approval",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000312";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000313",
    threadId: created.thread.id,
    turnId,
    input: { text: "run guarded tool" },
  });

  const approvalView = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "approval.required"),
    "v1.0 未收到 approval.required",
  );
  assert.ok(approvalView.event.type === "approval.required");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(
    client.wire.some(
      (message) =>
        "method" in message && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    ),
    false,
  );

  const responded = (await client.request(4, RUNTIME_METHODS.approvalRespond, {
    requestId: "00000000-0000-4000-8000-000000000314",
    threadId: created.thread.id,
    turnId,
    approvalId: approvalView.event.approval.id,
    decision: "approve",
  })) as { readonly resolved: boolean };
  assert.equal(responded.resolved, true);
  await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "turn.completed"),
    "v1.0 审批后 Turn 未完成",
  );
  assert.equal(
    client.events.some((envelope) => envelope.event.type === "approval.resolved"),
    false,
  );
  assert.equal(
    client.events.every((event) => event.protocolVersion === "1.0"),
    true,
  );
});

test("Runtime Protocol 1.1 在 Turn cancel 时取消未决 server request", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "cancel-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000321",
    title: "cancel approval",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000322";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000323",
    threadId: created.thread.id,
    turnId,
    input: { text: "cancel guarded tool" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "取消测试未收到 approval.request",
  );
  const cancelled = (await client.request(4, RUNTIME_METHODS.turnCancel, {
    requestId: "00000000-0000-4000-8000-000000000324",
    threadId: created.thread.id,
    turnId,
  })) as { readonly cancelling: boolean };
  assert.equal(cancelled.cancelling, true);
  const cancelNotification = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcNotification =>
          isNotification(message) && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
      ),
    "未收到 runtime.serverRequest.cancel",
  );
  assert.deepEqual(cancelNotification.params, {
    serverRequestId: approvalRequest.id,
    approvalId: (approvalRequest.params as ApprovalRequestParams).approval.id,
    reason: "Turn 已由客户端取消",
  });
  const resolution = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "approval.resolved"),
    "取消后未收到 approval.resolved",
  );
  assert.ok(resolution.event.type === "approval.resolved");
  assert.deepEqual(resolution.event.resolution, {
    status: "cancelled",
    reason: "Turn 已由客户端取消",
  });
  const terminal = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "turn.cancelled"),
    "取消后未收到 turn.cancelled",
  );
  assert.ok(client.events.indexOf(resolution) < client.events.indexOf(terminal));

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    client.events.filter((envelope) => envelope.event.type === "approval.resolved").length,
    1,
  );
});

test("Runtime Protocol 1.1 在 Turn timeout 时过期审批并拒绝迟到批准", async (t) => {
  let executionCount = 0;
  const harness = createApprovalProtocolHarness(() => {
    executionCount += 1;
  }, 100);
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "timeout-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000381",
    title: "timeout approval",
  })) as { readonly thread: { readonly id: string } };
  const turnId = "00000000-0000-4000-8000-000000000382";
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000383",
    threadId: created.thread.id,
    turnId,
    input: { text: "timeout guarded tool" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "超时测试未收到 approval.request",
  );
  const cancelNotification = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcNotification =>
          isNotification(message) && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
      ),
    "超时后未收到 runtime.serverRequest.cancel",
  );
  assert.deepEqual(cancelNotification.params, {
    serverRequestId: approvalRequest.id,
    approvalId: (approvalRequest.params as ApprovalRequestParams).approval.id,
    reason: "Turn 已超时",
  });
  const resolution = await waitForValue(
    () => client.events.find((envelope) => envelope.event.type === "approval.resolved"),
    "超时后未收到 approval.resolved",
  );
  assert.ok(resolution.event.type === "approval.resolved");
  assert.deepEqual(resolution.event.resolution, {
    status: "expired",
    reason: "Turn 已超时",
  });
  const terminal = await waitForValue(
    () =>
      client.events.find(
        (envelope) => envelope.turnId === turnId && envelope.event.type === "turn.cancelled",
      ),
    "超时后未收到 turn.cancelled",
  );
  assert.ok(terminal.event.type === "turn.cancelled");
  assert.equal(terminal.event.reason, "timeout");
  assert.equal(executionCount, 0);

  harness.clientConn.send({
    jsonrpc: "2.0",
    id: approvalRequest.id,
    result: { decision: "approve" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executionCount, 0);
  assert.equal(
    client.events.filter((envelope) => envelope.event.type === "approval.resolved").length,
    1,
  );
});

test("RuntimeServer.abortAll 对未决审批发送 cancel 并 fail-closed 收口", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.1"],
    client: { name: "disconnect-client", version: "1.1.0" },
  });
  const created = (await client.request(2, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-000000000331",
    title: "disconnect approval",
  })) as { readonly thread: { readonly id: string } };
  await client.request(3, RUNTIME_METHODS.turnStart, {
    requestId: "00000000-0000-4000-8000-000000000332",
    threadId: created.thread.id,
    turnId: "00000000-0000-4000-8000-000000000333",
    input: { text: "disconnect guarded tool" },
  });
  const approvalRequest = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcRequest =>
          isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ),
    "断连测试未收到 approval.request",
  );
  await harness.server.abortAll();
  const cancelNotification = await waitForValue(
    () =>
      client.wire.find(
        (message): message is JsonRpcNotification =>
          isNotification(message) && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
      ),
    "abortAll 未取消未决 server request",
  );
  assert.equal(
    (cancelNotification.params as { readonly serverRequestId: string | number }).serverRequestId,
    approvalRequest.id,
  );
  assert.equal(
    client.events.some((envelope) => envelope.event.type === "tool.completed"),
    false,
  );
});

test("Runtime Protocol 1.4 routes attachment methods to the service and gates 1.3 sessions", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.4"],
    client: { name: "attachment-routing-client", version: "1.0.0" },
  });
  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [],
  });
  const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-0000000000e0",
    title: "attachment routing",
  })) as { readonly thread: { readonly id: string } };
  const stageParams = {
    requestId: "00000000-0000-4000-8000-0000000000e1",
    threadId: created.thread.id,
    fileName: "shot.png",
    mediaType: "image/png",
    bytes: 5,
    sha256: "a".repeat(64),
    source: "local-path",
    sourcePath: "/tmp/shot.png",
  };
  const reachedService = (await client.requestError(
    4,
    RUNTIME_METHODS.attachmentStage,
    stageParams,
  )) as {
    readonly message?: string;
    readonly data?: { readonly rollCode?: string };
  };
  assert.equal(reachedService.data?.rollCode, "CAPABILITY_UNAVAILABLE");
  assert.match(reachedService.message ?? "", /未配置附件存储/u);

  const legacyHarness = createApprovalProtocolHarness();
  const legacy = attachRuntimeProtocolClient(legacyHarness.clientConn);
  t.after(() => legacyHarness.close());
  await legacy.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.3"],
    client: { name: "v13-attachment-client", version: "1.3.0" },
  });
  await legacy.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [],
  });
  const gated = (await legacy.requestError(3, RUNTIME_METHODS.attachmentStage, stageParams)) as {
    readonly message?: string;
    readonly data?: { readonly rollCode?: string };
  };
  assert.equal(gated.data?.rollCode, "CAPABILITY_UNAVAILABLE");
  assert.match(gated.message ?? "", /1\.3 不支持方法/u);
});

test("Runtime Protocol 1.4 sessions receive the bounded recovery snapshot projection", async (t) => {
  const harness = createApprovalProtocolHarness();
  const client = attachRuntimeProtocolClient(harness.clientConn);
  t.after(() => harness.close());

  await client.request(1, RUNTIME_METHODS.initialize, {
    protocolVersions: ["1.4"],
    client: { name: "v14-recovery-client", version: "1.0.0" },
  });
  await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 1,
    serverRequestMethods: [],
  });
  const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
    requestId: "00000000-0000-4000-8000-0000000000e5",
    title: "v14 recovery",
  })) as { readonly thread: { readonly id: string } };
  const threadId = threadIdSchema.parse(created.thread.id);
  harness.store.appendMessages(threadId, [{ role: "assistant", content: "x".repeat(2_048) }]);

  const recovery = (await client.request(4, RUNTIME_METHODS.threadSnapshot, {
    threadId,
    limit: 1,
    recovery: true,
  })) as {
    readonly recoveryProjection?: true;
    readonly messages: { readonly items: readonly unknown[] };
  };
  assert.equal(recovery.recoveryProjection, true);
  assert.deepEqual(recovery.messages.items, []);
});

for (const protocolVersion of ["1.3", "1.4"] as const) {
  test(`Runtime Protocol ${protocolVersion} 在 Turn cancel 时以 interaction 形状取消未决 server request`, async (t) => {
    const harness = createApprovalProtocolHarness();
    const client = attachRuntimeProtocolClient(harness.clientConn);
    t.after(() => harness.close());

    await client.request(1, RUNTIME_METHODS.initialize, {
      protocolVersions: [protocolVersion],
      client: { name: "cancel-client", version: "1.4.0" },
    });
    await client.request(2, RUNTIME_METHODS.clientCapabilitiesSet, {
      revision: 1,
      serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
    });
    const created = (await client.request(3, RUNTIME_METHODS.threadCreate, {
      requestId: "00000000-0000-4000-8000-000000000341",
      title: "cancel approval",
    })) as { readonly thread: { readonly id: string } };
    const turnId = "00000000-0000-4000-8000-000000000342";
    await client.request(4, RUNTIME_METHODS.turnStart, {
      requestId: "00000000-0000-4000-8000-000000000343",
      threadId: created.thread.id,
      turnId,
      input: { text: "cancel guarded tool" },
    });
    const approvalRequest = await waitForValue(
      () =>
        client.wire.find(
          (message): message is JsonRpcRequest =>
            isRequest(message) && message.method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
        ),
      "取消测试未收到 approval.request",
    );
    const interactionId = (approvalRequest.params as ApprovalRequestParamsV12).interactionId;
    const cancelled = (await client.request(5, RUNTIME_METHODS.turnCancel, {
      requestId: "00000000-0000-4000-8000-000000000344",
      threadId: created.thread.id,
      turnId,
    })) as { readonly cancelling: boolean };
    assert.equal(cancelled.cancelling, true);
    const cancelNotification = await waitForValue(
      () =>
        client.wire.find(
          (message): message is JsonRpcNotification =>
            isNotification(message) &&
            message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
        ),
      "未收到 runtime.serverRequest.cancel",
    );
    assert.deepEqual(cancelNotification.params, {
      interactionId,
      reason: "Turn 已由客户端取消",
    });
  });
}
