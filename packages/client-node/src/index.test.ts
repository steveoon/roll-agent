import assert from "node:assert/strict";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import clientNodePackage from "../package.json" with { type: "json" };
import {
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  RUNTIME_SERVER_REQUEST_METHODS,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  parseRuntimeMethodParams,
  runtimeEventEnvelopeSchema,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type RuntimeEventEnvelope,
  type RuntimeProtocolVersion,
} from "@roll-agent/protocol";
import {
  RollNodeClient,
  RollProtocolViolationError,
  RollRequestFrameTooLargeError,
  RollRequestTimeoutError,
  RollRpcError,
  RollRuntimeClosingError,
  RollRuntimeExitedError,
  RollRuntimeShutdownTimeoutError,
  RollUncorrelatedRpcError,
  type RuntimeClientExit,
  type RuntimeClientTransport,
  type RuntimeServerRequestHandler,
} from "./index.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000301",
  thread: "00000000-0000-4000-8000-000000000302",
  turn: "00000000-0000-4000-8000-000000000303",
  request: "00000000-0000-4000-8000-000000000304",
  approval: "00000000-0000-4000-8000-000000000305",
} as const;

class MemoryTransport implements RuntimeClientTransport {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  close(): void {
    this.exit(0, null);
  }

  terminate(): void {
    this.exit(null, "SIGTERM");
  }

  forceClose(): void {
    this.exit(null, "SIGKILL");
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.exitListeners) {
      listener(code, signal);
    }
  }
}

class ControlledWritable extends Writable {
  readonly frames: JsonRpcMessage[] = [];
  onFrame: ((message: JsonRpcMessage) => void) | undefined;
  private blockNextWrite = false;
  private releaseBlocked: (() => void) | undefined;
  private resolveBlocked: (() => void) | undefined;

  constructor() {
    super({ highWaterMark: 1 });
  }

  blockNext(): Promise<void> {
    if (this.blockNextWrite || this.releaseBlocked !== undefined) {
      throw new Error("A write is already blocked");
    }
    this.blockNextWrite = true;
    return new Promise<void>((resolve) => {
      this.resolveBlocked = resolve;
    });
  }

  release(): void {
    const release = this.releaseBlocked;
    this.releaseBlocked = undefined;
    release?.();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const message = JSON.parse(chunk.toString().trim()) as JsonRpcMessage;
    this.frames.push(message);
    this.onFrame?.(message);
    if (this.blockNextWrite) {
      this.blockNextWrite = false;
      this.releaseBlocked = callback;
      this.resolveBlocked?.();
      this.resolveBlocked = undefined;
      return;
    }
    callback();
  }
}

class ControlledTransport implements RuntimeClientTransport {
  readonly stdin = new ControlledWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  closeCalls = 0;
  private readonly exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  close(): void {
    this.closeCalls += 1;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.exitListeners) {
      listener(code, signal);
    }
  }
}

class TerminatesAfterGracefulTimeoutTransport extends MemoryTransport {
  closeCalls = 0;
  terminateCalls = 0;
  forceCloseCalls = 0;

  override close(): void {
    this.closeCalls += 1;
  }

  override terminate(): void {
    this.terminateCalls += 1;
    this.exit(null, "SIGTERM");
  }

  override forceClose(): void {
    this.forceCloseCalls += 1;
    this.exit(null, "SIGKILL");
  }
}

function writeJson(stream: PassThrough, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function approvalRequestParams() {
  return {
    threadId: IDS.thread,
    approval: {
      id: IDS.approval,
      turnId: IDS.turn,
      agentName: "browser-use-agent",
      toolName: "click",
      preview: { selector: "#submit" },
      reason: "This action submits the form",
    },
    expiresAt: "2026-07-29T12:10:00.000Z",
  } as const;
}

function findClientResponse(
  messages: readonly JsonRpcMessage[],
  id: string | number,
): JsonRpcMessage | undefined {
  return messages.find(
    (message) =>
      "id" in message &&
      message.id === id &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")),
  );
}

async function flushMessages(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function selectProtocolVersion(request: JsonRpcRequest): RuntimeProtocolVersion {
  const initialize = parseRuntimeMethodParams(RUNTIME_METHODS.initialize, request.params);
  const selected = SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.find((version) =>
    initialize.protocolVersions.includes(version),
  );
  assert.ok(selected, "fake Runtime and client must share a protocol version");
  return selected;
}

function installFakeRuntime(
  transport: MemoryTransport,
  onClientMessage?: (message: JsonRpcMessage) => void,
): void {
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const message = JSON.parse(line) as JsonRpcMessage;
    onClientMessage?.(message);
    if (!("method" in message) || !("id" in message)) {
      return;
    }
    const request = message;
    switch (request.method) {
      case RUNTIME_METHODS.initialize:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: selectProtocolVersion(request),
            runtimeInstanceId: IDS.runtime,
            server: {
              name: "fake-runtime",
              version: "1.0.0",
              runtimeVersion: "0.9.0",
            },
            features: ["thread-management", "turns"],
            limits: {
              maxFrameBytes: 4 * 1_024 * 1_024,
              maxPageSize: 500,
              eventReplay: false,
              idempotencyCacheEntries: 10_000,
            },
          },
        });
        return;
      case RUNTIME_METHODS.threadList:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          result: { items: [], nextCursor: null },
        });
        return;
      case RUNTIME_METHODS.threadOpen:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32_000,
            message: "missing",
            data: { rollCode: "THREAD_NOT_FOUND", retryable: false },
          },
        });
        return;
      case RUNTIME_METHODS.turnStart:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          result: { accepted: true, turnId: IDS.turn },
        });
        return;
      default:
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_601, message: "Method not found" },
        });
    }
  });
}

function installControlledFakeRuntime(
  transport: ControlledTransport,
  onClientMessage?: (message: JsonRpcMessage) => void,
): void {
  transport.stdin.onFrame = (message) => {
    onClientMessage?.(message);
    if (!("method" in message) || !("id" in message)) {
      return;
    }
    if (message.method === RUNTIME_METHODS.initialize) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: selectProtocolVersion(message),
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "fake-runtime",
            version: "1.0.0",
            runtimeVersion: "0.9.0",
          },
          features: [],
          limits: {
            maxFrameBytes: 4 * 1_024 * 1_024,
            maxPageSize: 500,
            eventReplay: false,
            idempotencyCacheEntries: 10_000,
          },
        },
      });
      return;
    }
    if (message.method === RUNTIME_METHODS.threadList) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: { items: [], nextCursor: null },
      });
    }
  };
}

function terminalEvent(protocolVersion: RuntimeProtocolVersion): RuntimeEventEnvelope {
  return runtimeEventEnvelopeSchema.parse({
    protocolVersion,
    runtimeInstanceId: IDS.runtime,
    sequence: 1,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event: { type: "turn.completed" },
  });
}

test("RollNodeClient initializes, validates responses and surfaces structured errors", async () => {
  const transport = new MemoryTransport();
  const messages: JsonRpcMessage[] = [];
  installFakeRuntime(transport, (message) => messages.push(message));
  const stderr: string[] = [];
  const client = await RollNodeClient.connect({
    transport,
    onStderr: (line) => stderr.push(line),
  });
  const initializeRequest = messages.find(
    (message): message is JsonRpcRequest =>
      "method" in message && "id" in message && message.method === RUNTIME_METHODS.initialize,
  );
  assert.ok(initializeRequest);
  assert.equal(
    parseRuntimeMethodParams(RUNTIME_METHODS.initialize, initializeRequest.params).client.version,
    clientNodePackage.version,
  );

  assert.deepEqual(await client.request(RUNTIME_METHODS.threadList, {}), {
    items: [],
    nextCursor: null,
  });
  await assert.rejects(
    client.request(RUNTIME_METHODS.threadOpen, { threadId: IDS.thread }),
    (error: unknown) => {
      assert.ok(error instanceof RollRpcError);
      assert.equal(error.data?.rollCode, "THREAD_NOT_FOUND");
      return true;
    },
  );
  transport.stderr.write("runtime diagnostic\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(stderr, ["runtime diagnostic"]);
  client.close();
});

test("RollNodeClient advertises Server Request protocol versions only when handlers exist", async () => {
  const legacyTransport = new MemoryTransport();
  const legacyMessages: JsonRpcMessage[] = [];
  installFakeRuntime(legacyTransport, (message) => legacyMessages.push(message));
  const legacyClient = await RollNodeClient.connect({ transport: legacyTransport });
  const legacyInitialize = legacyMessages.find(
    (message) => "method" in message && message.method === RUNTIME_METHODS.initialize,
  );
  assert.ok(legacyInitialize && "method" in legacyInitialize && "id" in legacyInitialize);
  assert.deepEqual(
    parseRuntimeMethodParams(RUNTIME_METHODS.initialize, legacyInitialize.params).protocolVersions,
    ["1.0"],
  );
  assert.equal(legacyClient.getInitializationResult().protocolVersion, "1.0");

  const lateHandler: RuntimeServerRequestHandler<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  > = async () => ({ decision: "approve" });
  assert.throws(
    () =>
      legacyClient.registerServerRequestHandler(
        RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
        lateHandler,
      ),
    /pass serverRequestHandlers/u,
  );
  await legacyClient.shutdown();

  const v11Transport = new MemoryTransport();
  const v11Messages: JsonRpcMessage[] = [];
  installFakeRuntime(v11Transport, (message) => v11Messages.push(message));
  const v11Client = await RollNodeClient.connect({
    transport: v11Transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
        decision: "approve",
      }),
    },
  });
  const v11Initialize = v11Messages.find(
    (message) => "method" in message && message.method === RUNTIME_METHODS.initialize,
  );
  assert.ok(v11Initialize && "method" in v11Initialize && "id" in v11Initialize);
  assert.deepEqual(
    parseRuntimeMethodParams(RUNTIME_METHODS.initialize, v11Initialize.params).protocolVersions,
    ["1.1", "1.0"],
  );
  assert.equal(v11Client.getInitializationResult().protocolVersion, "1.1");
  await v11Client.shutdown();

  const oldRuntimeTransport = new MemoryTransport();
  const oldRuntimeMessages: JsonRpcMessage[] = [];
  const oldRuntimeReader = createInterface({ input: oldRuntimeTransport.stdin });
  oldRuntimeReader.on("line", (line) => {
    const message = JSON.parse(line) as JsonRpcMessage;
    oldRuntimeMessages.push(message);
    if (!("method" in message) || !("id" in message)) {
      return;
    }
    assert.equal(message.method, RUNTIME_METHODS.initialize);
    writeJson(oldRuntimeTransport.stdout, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "1.0",
        runtimeInstanceId: IDS.runtime,
        server: {
          name: "old-runtime",
          version: "1.0.0",
          runtimeVersion: "0.8.0",
        },
        features: ["thread-management", "turns"],
        limits: {
          maxFrameBytes: 4 * 1_024 * 1_024,
          maxPageSize: 500,
          eventReplay: false,
          idempotencyCacheEntries: 10_000,
        },
      },
    });
  });
  const fallbackClient = await RollNodeClient.connect({
    transport: oldRuntimeTransport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
        decision: "approve",
      }),
    },
  });
  const fallbackInitialize = oldRuntimeMessages.find(
    (message) => "method" in message && message.method === RUNTIME_METHODS.initialize,
  );
  assert.ok(fallbackInitialize && "method" in fallbackInitialize && "id" in fallbackInitialize);
  assert.deepEqual(
    parseRuntimeMethodParams(RUNTIME_METHODS.initialize, fallbackInitialize.params)
      .protocolVersions,
    ["1.1", "1.0"],
  );
  assert.equal(fallbackClient.getInitializationResult().protocolVersion, "1.0");
  await fallbackClient.shutdown();
});

test("RollNodeClient dispatches typed Server Requests and supports dynamic replacement", async () => {
  const transport = new MemoryTransport();
  const messages: JsonRpcMessage[] = [];
  installFakeRuntime(transport, (message) => messages.push(message));
  const client = await RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
        decision: "approve",
      }),
    },
  });

  let contextRequestId: string | number | undefined;
  let handlerSignal: AbortSignal | undefined;
  let supersededHandlerCalls = 0;
  const unregisterSuperseded = client.registerServerRequestHandler(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    async () => {
      supersededHandlerCalls += 1;
      return { decision: "approve" };
    },
  );
  const unregisterActive = client.registerServerRequestHandler(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    async (params, context) => {
      assert.equal(params.approval.id, IDS.approval);
      contextRequestId = context.requestId;
      handlerSignal = context.signal;
      return { decision: "reject", reason: "GUI denied the action" };
    },
  );
  unregisterSuperseded();

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-rpc-success",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParams(),
  });
  await flushMessages();

  const response = findClientResponse(messages, "approval-rpc-success");
  assert.ok(response && "result" in response);
  assert.deepEqual(response.result, {
    decision: "reject",
    reason: "GUI denied the action",
  });
  assert.equal(contextRequestId, "approval-rpc-success");
  assert.equal(handlerSignal?.aborted, false);
  assert.equal(supersededHandlerCalls, 0);

  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));
  unregisterActive();
  const exit = await exited;
  assert.ok(exit.error instanceof RollProtocolViolationError);
  assert.match(exit.error.message, /Cannot unregister required Runtime server request handler/u);
  assert.equal((await client.shutdown()).error, exit.error);
});

test("RollNodeClient returns bounded JSON-RPC errors for rejected Server Requests", async () => {
  const transport = new MemoryTransport();
  const messages: JsonRpcMessage[] = [];
  installFakeRuntime(transport, (message) => messages.push(message));
  const client = await RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
        decision: "approve",
      }),
    },
  });

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "unknown-rpc",
    method: "gui.unknown",
    params: {},
  });
  await flushMessages();
  const unknown = findClientResponse(messages, "unknown-rpc");
  assert.ok(unknown && "error" in unknown);
  assert.equal(unknown.error.code, -32_601);
  assert.equal(unknown.error.message, "Method not found");

  client.registerServerRequestHandler(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, async () => {
    throw new Error("secret-handler-detail");
  });
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "throwing-rpc",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParams(),
  });
  await flushMessages();
  const throwing = findClientResponse(messages, "throwing-rpc");
  assert.ok(throwing && "error" in throwing);
  assert.equal(throwing.error.code, -32_603);
  assert.equal(throwing.error.message, "Internal error");
  assert.doesNotMatch(throwing.error.message, /secret-handler-detail/u);

  const invalidHandler = (async () => ({
    decision: "approve",
    reason: "not valid for approval",
  })) as unknown as RuntimeServerRequestHandler<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  >;
  client.registerServerRequestHandler(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    invalidHandler,
  );
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "invalid-result-rpc",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParams(),
  });
  await flushMessages();
  const invalidResult = findClientResponse(messages, "invalid-result-rpc");
  assert.ok(invalidResult && "error" in invalidResult);
  assert.equal(invalidResult.error.code, -32_603);
  assert.equal(invalidResult.error.message, "Internal error");
  assert.doesNotMatch(invalidResult.error.message, /not valid for approval/u);

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "invalid-params-rpc",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: { threadId: "not-a-uuid" },
  });
  await flushMessages();
  const invalidParams = findClientResponse(messages, "invalid-params-rpc");
  assert.ok(invalidParams && "error" in invalidParams);
  assert.equal(invalidParams.error.code, -32_602);
  assert.equal(invalidParams.error.message, "Invalid params");

  assert.deepEqual(await client.request(RUNTIME_METHODS.threadList, {}), {
    items: [],
    nextCursor: null,
  });
  await client.shutdown();
});

test("RollNodeClient cancellation aborts approval without applying the request timeout", async () => {
  const transport = new MemoryTransport();
  const messages: JsonRpcMessage[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  let handlerSignal: AbortSignal | undefined;
  installFakeRuntime(transport, (message) => messages.push(message));
  const client = await RollNodeClient.connect({
    transport,
    requestTimeoutMs: 10,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async (_params, context) => {
        handlerSignal = context.signal;
        resolveStarted();
        return await new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              resolveAborted();
              resolve({ decision: "approve" });
            },
            { once: true },
          );
        });
      },
    },
  });

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-rpc-cancel",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParams(),
  });
  await started;
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(handlerSignal?.aborted, false);

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    params: {
      serverRequestId: "approval-rpc-cancel",
      approvalId: IDS.approval,
      reason: "turn-cancelled",
    },
  });
  await aborted;
  await flushMessages();
  assert.equal(handlerSignal?.aborted, true);
  assert.ok(handlerSignal?.reason instanceof Error);
  assert.equal(handlerSignal.reason.message, "turn-cancelled");
  assert.equal(findClientResponse(messages, "approval-rpc-cancel"), undefined);
  await client.shutdown();
});

test("RollNodeClient suppresses a queued Server Request response after cancellation", async () => {
  const transport = new ControlledTransport();
  installControlledFakeRuntime(transport);
  const client = await RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
        decision: "approve",
      }),
    },
  });

  const blocked = transport.stdin.blockNext();
  const read = client.request(RUNTIME_METHODS.threadList, {});
  await blocked;
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-rpc-queued-cancel",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParams(),
  });
  await flushMessages();
  await flushMessages();
  assert.equal(findClientResponse(transport.stdin.frames, "approval-rpc-queued-cancel"), undefined);

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    params: {
      serverRequestId: "approval-rpc-queued-cancel",
      approvalId: IDS.approval,
      reason: "turn-cancelled",
    },
  });
  await flushMessages();
  transport.stdin.release();
  assert.deepEqual(await read, { items: [], nextCursor: null });
  await flushMessages();
  assert.equal(findClientResponse(transport.stdin.frames, "approval-rpc-queued-cancel"), undefined);

  const shutdown = client.shutdown({
    gracefulTimeoutMs: 1_000,
    terminateTimeoutMs: 1_000,
    forceKillTimeoutMs: 1_000,
  });
  transport.exit(0, null);
  await shutdown;
});

test("RollNodeClient suppresses a queued Server Request response after shutdown begins", async () => {
  const transport = new ControlledTransport();
  installControlledFakeRuntime(transport);
  const client = await RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
        decision: "approve",
      }),
    },
  });

  const blocked = transport.stdin.blockNext();
  const read = client.request(RUNTIME_METHODS.threadList, {});
  await blocked;
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-rpc-queued-shutdown",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParams(),
  });
  await flushMessages();
  await flushMessages();

  const shutdown = client.shutdown({
    gracefulTimeoutMs: 1_000,
    terminateTimeoutMs: 1_000,
    forceKillTimeoutMs: 1_000,
  });
  assert.equal(transport.closeCalls, 1);
  transport.stdin.release();
  assert.deepEqual(await read, { items: [], nextCursor: null });
  await flushMessages();
  assert.equal(
    findClientResponse(transport.stdin.frames, "approval-rpc-queued-shutdown"),
    undefined,
  );
  transport.exit(0, null);
  await shutdown;
});

for (const lifecycle of ["shutdown", "exit"] as const) {
  test(`RollNodeClient ${lifecycle} aborts in-flight Server Requests`, async () => {
    const transport = new MemoryTransport();
    const messages: JsonRpcMessage[] = [];
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    installFakeRuntime(transport, (message) => messages.push(message));
    const client = await RollNodeClient.connect({
      transport,
      serverRequestHandlers: {
        [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async (_params, context) => {
          resolveStarted();
          return await new Promise((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                resolveAborted();
                resolve({ decision: "approve" });
              },
              { once: true },
            );
          });
        },
      },
    });

    const requestId = `approval-rpc-${lifecycle}`;
    writeJson(transport.stdout, {
      jsonrpc: "2.0",
      id: requestId,
      method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      params: approvalRequestParams(),
    });
    await started;
    if (lifecycle === "shutdown") {
      await client.shutdown();
    } else {
      transport.exit(9, null);
    }
    await aborted;
    await flushMessages();
    assert.equal(findClientResponse(messages, requestId), undefined);
  });
}

test("RollNodeClient does not start Server Request handlers after shutdown begins", async () => {
  class DeferredExitTransport extends MemoryTransport {
    override close(): void {}
  }

  const transport = new DeferredExitTransport();
  const messages: JsonRpcMessage[] = [];
  let handlerCalls = 0;
  installFakeRuntime(transport, (message) => messages.push(message));
  const client = await RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => {
        handlerCalls += 1;
        return { decision: "approve" };
      },
    },
  });

  const shutdown = client.shutdown({
    gracefulTimeoutMs: 1_000,
    terminateTimeoutMs: 1_000,
    forceKillTimeoutMs: 1_000,
  });
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-rpc-after-shutdown",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParams(),
  });
  await flushMessages();
  assert.equal(handlerCalls, 0);
  assert.equal(findClientResponse(messages, "approval-rpc-after-shutdown"), undefined);

  transport.exit(0, null);
  await shutdown;
});

test("RollNodeClient binds runtime.event to the negotiated Protocol", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });
  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_EVENT_NOTIFICATION,
    params: terminalEvent("1.1"),
  });
  assert.ok((await exited).error instanceof RollProtocolViolationError);

  const preInitializeTransport = new MemoryTransport();
  const connecting = RollNodeClient.connect({
    transport: preInitializeTransport,
    requestTimeoutMs: 1_000,
  });
  writeJson(preInitializeTransport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_EVENT_NOTIFICATION,
    params: terminalEvent("1.0"),
  });
  await assert.rejects(connecting, RollProtocolViolationError);
});

test("RollNodeClient isolates runtime.event listeners and continues fanout", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });
  const events: RuntimeEventEnvelope[] = [];
  client.onEvent(() => {
    throw new Error("listener failed");
  });
  client.onEvent((event) => events.push(event));

  assert.doesNotThrow(() => {
    writeJson(transport.stdout, {
      jsonrpc: "2.0",
      method: RUNTIME_EVENT_NOTIFICATION,
      params: terminalEvent("1.0"),
    });
  });
  await flushMessages();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.event.type, "turn.completed");
  assert.deepEqual(client.getOutcomeUnknownTurnIds(), []);
  await client.shutdown();
});

test("RollNodeClient rejects a Runtime-selected protocol version it did not advertise", async () => {
  const transport = new MemoryTransport();
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    if (request.method !== RUNTIME_METHODS.initialize) {
      return;
    }
    assert.deepEqual(
      parseRuntimeMethodParams(RUNTIME_METHODS.initialize, request.params).protocolVersions,
      ["1.0"],
    );
    writeJson(transport.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "1.1",
        runtimeInstanceId: IDS.runtime,
        server: {
          name: "bad-negotiation-runtime",
          version: "1.0.0",
          runtimeVersion: "0.9.0",
        },
        features: [],
        limits: {
          maxFrameBytes: 4 * 1_024 * 1_024,
          maxPageSize: 500,
          eventReplay: false,
          idempotencyCacheEntries: 10_000,
        },
      },
    });
  });

  await assert.rejects(RollNodeClient.connect({ transport }), RollProtocolViolationError);
});

test("RollNodeClient separates inbound Server Requests from same-id outbound responses", async () => {
  const transport = new MemoryTransport();
  let serverRequestResponse: JsonRpcMessage | undefined;
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const message = JSON.parse(line) as JsonRpcMessage;
    if ("method" in message && "id" in message) {
      if (message.method === RUNTIME_METHODS.initialize) {
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: selectProtocolVersion(message),
            runtimeInstanceId: IDS.runtime,
            server: {
              name: "same-id-runtime",
              version: "1.0.0",
              runtimeVersion: "0.9.0",
            },
            features: ["thread-management"],
            limits: {
              maxFrameBytes: 4 * 1_024 * 1_024,
              maxPageSize: 500,
              eventReplay: false,
              idempotencyCacheEntries: 10_000,
            },
          },
        });
        return;
      }
      if (message.method === RUNTIME_METHODS.threadList) {
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: message.id,
          method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
          params: approvalRequestParams(),
        });
      }
      return;
    }
    if ("id" in message && "result" in message) {
      serverRequestResponse = message;
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: { items: [], nextCursor: null },
      });
    }
  });
  const client = await RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
        decision: "approve",
      }),
    },
  });

  assert.deepEqual(await client.request(RUNTIME_METHODS.threadList, {}), {
    items: [],
    nextCursor: null,
  });
  assert.ok(serverRequestResponse && "result" in serverRequestResponse);
  assert.deepEqual(serverRequestResponse.result, { decision: "approve" });
  await client.shutdown();
});

test("RollNodeClient marks only unterminated active Turns as outcome unknown", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  const unknown: string[] = [];
  const events: RuntimeEventEnvelope[] = [];
  const client = await RollNodeClient.connect({
    transport,
    onTurnOutcomeUnknown: (turnId) => unknown.push(turnId),
  });
  client.onEvent((event) => events.push(event));

  await client.request(RUNTIME_METHODS.turnStart, {
    requestId: IDS.request,
    threadId: IDS.thread,
    turnId: IDS.turn,
    input: { text: "hello" },
  });
  transport.exit(1, null);
  assert.deepEqual(client.getOutcomeUnknownTurnIds(), [IDS.turn]);
  assert.deepEqual(unknown, [IDS.turn]);

  const completedTransport = new MemoryTransport();
  installFakeRuntime(completedTransport);
  const completedClient = await RollNodeClient.connect({ transport: completedTransport });
  await completedClient.request(RUNTIME_METHODS.turnStart, {
    requestId: IDS.request,
    threadId: IDS.thread,
    turnId: IDS.turn,
    input: { text: "hello" },
  });
  writeJson(completedTransport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_EVENT_NOTIFICATION,
    params: terminalEvent("1.0"),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  completedTransport.exit(1, null);
  assert.deepEqual(completedClient.getOutcomeUnknownTurnIds(), []);
  assert.deepEqual(events, []);
});

test("RollNodeClient observer failures cannot block exit settlement or later observers", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  let stderrCalls = 0;
  const client = await RollNodeClient.connect({
    transport,
    onStderr: () => {
      stderrCalls += 1;
      throw new Error("stderr observer failed");
    },
    onTurnOutcomeUnknown: () => {
      throw new Error("outcome observer failed");
    },
  });
  await client.request(RUNTIME_METHODS.turnStart, {
    requestId: IDS.request,
    threadId: IDS.thread,
    turnId: IDS.turn,
    input: { text: "hello" },
  });
  const exits: RuntimeClientExit[] = [];
  client.onExit(() => {
    throw new Error("exit observer failed");
  });
  client.onExit((exit) => exits.push(exit));

  transport.stderr.write("diagnostic\n");
  await flushMessages();
  assert.equal(stderrCalls, 1);
  assert.doesNotThrow(() => transport.exit(1, null));
  assert.deepEqual(client.getOutcomeUnknownTurnIds(), [IDS.turn]);
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.code, 1);

  client.onExit(() => {
    throw new Error("late exit observer failed");
  });
  await flushMessages();
});

test("RollNodeClient.start requires an explicit cwd before spawning", async () => {
  await assert.rejects(RollNodeClient.start({ cwd: "   " }), /requires an explicit non-empty cwd/u);
});

test("RollNodeClient retries retryable reads but never retries turn.start", async () => {
  const transport = new MemoryTransport();
  let listCalls = 0;
  let turnCalls = 0;
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    if (request.method === RUNTIME_METHODS.initialize) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: selectProtocolVersion(request),
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "retry-runtime",
            version: "1.0.0",
            runtimeVersion: "0.9.0",
          },
          features: ["thread-management"],
          limits: {
            maxFrameBytes: 4 * 1_024 * 1_024,
            maxPageSize: 500,
            eventReplay: false,
            idempotencyCacheEntries: 10_000,
          },
        },
      });
      return;
    }
    if (request.method === RUNTIME_METHODS.threadList) {
      listCalls += 1;
      writeJson(
        transport.stdout,
        listCalls === 1
          ? {
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32_000,
                message: "retry read",
                data: { rollCode: "RUNTIME_CLOSING", retryable: true },
              },
            }
          : {
              jsonrpc: "2.0",
              id: request.id,
              result: { items: [], nextCursor: null },
            },
      );
      return;
    }
    if (request.method === RUNTIME_METHODS.turnStart) {
      turnCalls += 1;
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32_000,
          message: "do not retry mutation",
          data: { rollCode: "RUNTIME_CLOSING", retryable: true },
        },
      });
    }
  });

  const client = await RollNodeClient.connect({
    transport,
    maxReadRetries: 1,
    readRetryDelayMs: 0,
  });
  assert.deepEqual(await client.request(RUNTIME_METHODS.threadList, {}), {
    items: [],
    nextCursor: null,
  });
  assert.equal(listCalls, 2);
  await assert.rejects(
    client.request(RUNTIME_METHODS.turnStart, {
      requestId: IDS.request,
      threadId: IDS.thread,
      turnId: IDS.turn,
      input: { text: "do not replay" },
    }),
    RollRpcError,
  );
  assert.equal(turnCalls, 1);
  client.close();
});

test("RollNodeClient exposes negotiated initialization and idle runtime exit", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });

  assert.equal(client.getInitializationResult().runtimeInstanceId, IDS.runtime);
  assert.equal(client.getInitializationResult().protocolVersion, "1.0");
  await assert.rejects(
    client.request(RUNTIME_METHODS.initialize, {
      protocolVersions: ["1.1"],
      client: { name: "renegotiating-client", version: "1.1.0" },
    }),
    /already completed initialization/u,
  );
  assert.equal(client.getInitializationResult().protocolVersion, "1.0");

  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));
  transport.exit(17, null);
  const result = await exited;
  assert.equal(result.code, 17);
  assert.ok(result.error instanceof RollRuntimeExitedError);

  const lateExit = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));
  assert.equal((await lateExit).code, 17);
});

test("RollNodeClient shutdown waits for exit, stays idempotent and preserves final stderr", async () => {
  class DeferredShutdownTransport extends MemoryTransport {
    closeCalls = 0;
    terminateCalls = 0;
    forceCloseCalls = 0;

    override close(): void {
      this.closeCalls += 1;
    }

    override terminate(): void {
      this.terminateCalls += 1;
      this.exit(null, "SIGTERM");
    }

    override forceClose(): void {
      this.forceCloseCalls += 1;
      this.exit(null, "SIGKILL");
    }
  }

  const transport = new DeferredShutdownTransport();
  installFakeRuntime(transport);
  const stderr: string[] = [];
  const client = await RollNodeClient.connect({
    transport,
    onStderr: (line) => stderr.push(line),
  });

  const firstShutdown = client.shutdown({
    gracefulTimeoutMs: 1_000,
    terminateTimeoutMs: 1_000,
    forceKillTimeoutMs: 1_000,
  });
  const secondShutdown = client.shutdown({
    gracefulTimeoutMs: 1,
    terminateTimeoutMs: 1,
    forceKillTimeoutMs: 1,
  });
  assert.equal(firstShutdown, secondShutdown);
  assert.equal(transport.closeCalls, 1);
  await assert.rejects(client.request(RUNTIME_METHODS.threadList, {}), RollRuntimeClosingError);

  transport.stderr.write("final cleanup diagnostic\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  transport.exit(0, null);
  const result = await firstShutdown;

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(transport.terminateCalls, 0);
  assert.equal(transport.forceCloseCalls, 0);
  assert.deepEqual(stderr, ["final cleanup diagnostic"]);
});

test("RollNodeClient shutdown terminates a Runtime that misses the graceful deadline", async () => {
  class StubbornTransport extends MemoryTransport {
    closeCalls = 0;
    terminateCalls = 0;
    forceCloseCalls = 0;

    override close(): void {
      this.closeCalls += 1;
    }

    override terminate(): void {
      this.terminateCalls += 1;
      this.exit(null, "SIGTERM");
    }

    override forceClose(): void {
      this.forceCloseCalls += 1;
      this.exit(null, "SIGKILL");
    }
  }

  const transport = new StubbornTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });
  const result = await client.shutdown({
    gracefulTimeoutMs: 10,
    terminateTimeoutMs: 1_000,
    forceKillTimeoutMs: 1_000,
  });

  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.terminateCalls, 1);
  assert.equal(transport.forceCloseCalls, 0);
  assert.equal(result.signal, "SIGTERM");
});

test("RollNodeClient shutdown force-closes a Runtime that ignores termination", async () => {
  class HardStopTransport extends MemoryTransport {
    override close(): void {}

    override terminate(): void {}

    override forceClose(): void {
      this.exit(null, "SIGKILL");
    }
  }

  const transport = new HardStopTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });
  const result = await client.shutdown({
    gracefulTimeoutMs: 10,
    terminateTimeoutMs: 10,
    forceKillTimeoutMs: 1_000,
  });

  assert.equal(result.signal, "SIGKILL");
});

test("RollNodeClient shutdown reports a bounded failure when forced close cannot finish", async () => {
  class UnresponsiveTransport extends MemoryTransport {
    override close(): void {}

    override terminate(): void {}

    override forceClose(): void {}
  }

  const transport = new UnresponsiveTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });

  await assert.rejects(
    client.shutdown({
      gracefulTimeoutMs: 10,
      terminateTimeoutMs: 10,
      forceKillTimeoutMs: 10,
    }),
    RollRuntimeShutdownTimeoutError,
  );
});

test("RollNodeClient closes transport when initialization times out", async () => {
  class TrackingTransport extends MemoryTransport {
    closed = false;

    override close(): void {
      this.closed = true;
      super.close();
    }
  }

  const transport = new TrackingTransport();
  await assert.rejects(
    RollNodeClient.connect({ transport, requestTimeoutMs: 20 }),
    RollRequestTimeoutError,
  );
  assert.equal(transport.closed, true);
});

test("RollNodeClient rejects malformed frames as protocol violations", async () => {
  const transport = new MemoryTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({ transport });
  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));

  transport.stdout.write("{not-json}\n");
  const result = await exited;
  assert.ok(result.error instanceof RollProtocolViolationError);
  await assert.rejects(client.request(RUNTIME_METHODS.threadList, {}), RollProtocolViolationError);
});

test("RollNodeClient protocol failures still escalate until the Runtime process exits", async () => {
  const transport = new TerminatesAfterGracefulTimeoutTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({
    transport,
    shutdownOptions: {
      gracefulTimeoutMs: 10,
      terminateTimeoutMs: 1_000,
      forceKillTimeoutMs: 1_000,
    },
  });
  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));

  transport.stdout.write("{not-json}\n");
  const result = await exited;

  assert.ok(result.error instanceof RollProtocolViolationError);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.terminateCalls, 1);
  assert.equal(transport.forceCloseCalls, 0);
  assert.equal((await client.shutdown()).error, result.error);
});

test(
  "RollNodeClient terminates a real child process after a protocol failure",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = [
      'import { createInterface } from "node:readline";',
      "const reader = createInterface({ input: process.stdin });",
      'reader.once("line", (line) => {',
      "  const request = JSON.parse(line);",
      "  process.stdout.write(`${JSON.stringify({",
      '    jsonrpc: "2.0",',
      "    id: request.id,",
      "    result: {",
      "      protocolVersion: request.params.protocolVersions[0],",
      `      runtimeInstanceId: "${IDS.runtime}",`,
      '      server: { name: "child-fixture", version: "1.0.0", runtimeVersion: "0.9.0" },',
      '      features: ["thread-management"],',
      "      limits: {",
      "        maxFrameBytes: 4194304,",
      "        maxPageSize: 500,",
      "        eventReplay: false,",
      "        idempotencyCacheEntries: 10000,",
      "      },",
      "    },",
      "  })}\\n`);",
      '  setTimeout(() => process.stdout.write("{not-json}\\n"), 25);',
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const client = await RollNodeClient.start({
      cwd: process.cwd(),
      command: process.execPath,
      args: ["--input-type=module", "--eval", fixture],
      requestTimeoutMs: 1_000,
      shutdownOptions: {
        gracefulTimeoutMs: 10,
        terminateTimeoutMs: 1_000,
        forceKillTimeoutMs: 1_000,
      },
    });
    const result = await new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));

    assert.ok(result.error instanceof RollProtocolViolationError);
    assert.equal(result.signal, "SIGTERM");
    assert.equal((await client.shutdown()).error, result.error);
  },
);

test("RollNodeClient treats id:null errors as structured uncorrelated RPC failures", async () => {
  const transport = new TerminatesAfterGracefulTimeoutTransport();
  installFakeRuntime(transport);
  const client = await RollNodeClient.connect({
    transport,
    shutdownOptions: {
      gracefulTimeoutMs: 10,
      terminateTimeoutMs: 1_000,
      forceKillTimeoutMs: 1_000,
    },
  });
  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32_700, message: "Parse error" },
  });
  const result = await exited;

  assert.ok(result.error instanceof RollUncorrelatedRpcError);
  assert.ok(result.error instanceof RollRpcError);
  assert.equal(result.error.code, -32_700);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.terminateCalls, 1);
  assert.equal(transport.forceCloseCalls, 0);
});

test("RollNodeClient rejects outbound frames above the negotiated limit before writing", async () => {
  const transport = new MemoryTransport();
  const methods: string[] = [];
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    methods.push(request.method);
    if (request.method !== RUNTIME_METHODS.initialize) {
      return;
    }
    writeJson(transport.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: selectProtocolVersion(request),
        runtimeInstanceId: IDS.runtime,
        server: {
          name: "small-frame-runtime",
          version: "1.0.0",
          runtimeVersion: "0.9.0",
        },
        features: ["thread-management", "turns"],
        limits: {
          maxFrameBytes: 1_024,
          maxPageSize: 500,
          eventReplay: false,
          idempotencyCacheEntries: 10_000,
        },
      },
    });
  });
  const client = await RollNodeClient.connect({ transport, maxFrameBytes: 4_096 });

  await assert.rejects(
    client.request(RUNTIME_METHODS.turnStart, {
      requestId: IDS.request,
      threadId: IDS.thread,
      turnId: IDS.turn,
      input: { text: "x".repeat(2_000) },
    }),
    RollRequestFrameTooLargeError,
  );
  assert.deepEqual(methods, [RUNTIME_METHODS.initialize]);
  assert.deepEqual(client.getOutcomeUnknownTurnIds(), []);
  await client.shutdown();
});

test("RollNodeClient rejects invalid method results and stops the connection", async () => {
  const transport = new MemoryTransport();
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    if (request.method === RUNTIME_METHODS.initialize) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: selectProtocolVersion(request),
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "invalid-result-runtime",
            version: "1.0.0",
            runtimeVersion: "0.9.0",
          },
          features: ["thread-management"],
          limits: {
            maxFrameBytes: 4 * 1_024 * 1_024,
            maxPageSize: 500,
            eventReplay: false,
            idempotencyCacheEntries: 10_000,
          },
        },
      });
      return;
    }
    writeJson(transport.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      result: { items: "not-an-array", nextCursor: null },
    });
  });

  const client = await RollNodeClient.connect({ transport });
  await assert.rejects(client.request(RUNTIME_METHODS.threadList, {}), RollProtocolViolationError);
});

test("RollNodeClient does not retry thread.open because opening mutates runtime state", async () => {
  const transport = new MemoryTransport();
  let openCalls = 0;
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line) as JsonRpcRequest;
    if (request.method === RUNTIME_METHODS.initialize) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: selectProtocolVersion(request),
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "open-runtime",
            version: "1.0.0",
            runtimeVersion: "0.9.0",
          },
          features: ["thread-management"],
          limits: {
            maxFrameBytes: 4 * 1_024 * 1_024,
            maxPageSize: 500,
            eventReplay: false,
            idempotencyCacheEntries: 10_000,
          },
        },
      });
      return;
    }
    if (request.method === RUNTIME_METHODS.threadOpen) {
      openCalls += 1;
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32_000,
          message: "retryable but stateful",
          data: { rollCode: "RUNTIME_CLOSING", retryable: true },
        },
      });
    }
  });

  const client = await RollNodeClient.connect({
    transport,
    maxReadRetries: 3,
    readRetryDelayMs: 0,
  });
  await assert.rejects(
    client.request(RUNTIME_METHODS.threadOpen, { threadId: IDS.thread }),
    RollRpcError,
  );
  assert.equal(openCalls, 1);
  client.close();
});
