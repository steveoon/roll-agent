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
  RUNTIME_V13_MIN_CLIENT_FRAME_BYTES,
  parseRuntimeMethodParams,
  projectClientCapabilitiesSetResult,
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
  type UserInputRequestHandler,
} from "./index.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000301",
  thread: "00000000-0000-4000-8000-000000000302",
  turn: "00000000-0000-4000-8000-000000000303",
  request: "00000000-0000-4000-8000-000000000304",
  approval: "00000000-0000-4000-8000-000000000305",
  interaction: "00000000-0000-4000-8000-000000000306",
  interaction2: "00000000-0000-4000-8000-000000000307",
  interaction3: "00000000-0000-4000-8000-000000000308",
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

function writeJsonChunk(stream: PassThrough, values: readonly unknown[]): void {
  stream.write(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
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

function approvalRequestParamsV12(interactionId: string = IDS.interaction) {
  return {
    interactionId,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: "2026-07-29T12:10:00.000Z",
    sensitivity: "normal",
    approval: {
      id: IDS.approval,
      turnId: IDS.turn,
      agentName: "browser-use-agent",
      toolName: "click",
      preview: { selector: "#submit" },
      reason: "This action submits the form",
    },
  } as const;
}

function deploymentRegionRequestParamsV12(interactionId: string = IDS.interaction) {
  return {
    interactionId,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: "2026-07-29T12:10:00.000Z",
    sensitivity: "normal",
    title: "部署配置",
    controls: [
      {
        type: "text",
        id: "deployment-region",
        label: "部署区域",
        required: true,
        minLength: 2,
        maxLength: 20,
      },
    ],
  } as const;
}

function targetWorkspaceRequestParamsV12(interactionId: string = IDS.interaction2) {
  return {
    interactionId,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: "2026-07-29T12:10:00.000Z",
    sensitivity: "normal",
    title: "Workspace 配置",
    controls: [
      {
        type: "choice",
        id: "target-workspace",
        label: "目标 Workspace",
        required: true,
        multiple: false,
        options: [
          { id: "workspace-a", label: "Workspace A" },
          { id: "workspace-b", label: "Workspace B" },
        ],
      },
    ],
  } as const;
}

function threadSnapshotResult() {
  return {
    thread: {
      id: IDS.thread,
      title: "Snapshot thread",
      model: "mock-model",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    transcriptCompleteness: "complete",
  } as const;
}

function installThreadSnapshotRuntime(
  transport: MemoryTransport,
  protocolVersion: RuntimeProtocolVersion,
  snapshot: unknown,
): void {
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const message = JSON.parse(line) as JsonRpcMessage;
    if (!("method" in message) || !("id" in message)) {
      return;
    }
    if (message.method === RUNTIME_METHODS.initialize) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion,
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "snapshot-runtime",
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
    if (message.method === RUNTIME_METHODS.clientCapabilitiesSet) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: projectClientCapabilitiesSetResult(message.params),
      });
      return;
    }
    if (message.method === RUNTIME_METHODS.threadSnapshot) {
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: snapshot,
      });
    }
  });
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

function selectProtocolVersion(
  request: JsonRpcRequest,
  runtimeProtocolVersions: readonly RuntimeProtocolVersion[] = ["1.1", "1.0"],
): RuntimeProtocolVersion {
  const initialize = parseRuntimeMethodParams(RUNTIME_METHODS.initialize, request.params);
  const selected = runtimeProtocolVersions.find((version) =>
    initialize.protocolVersions.includes(version),
  );
  assert.ok(selected, "fake Runtime and client must share a protocol version");
  return selected;
}

function installFakeRuntime(
  transport: MemoryTransport,
  onClientMessage?: (message: JsonRpcMessage) => void,
  runtimeProtocolVersions: readonly RuntimeProtocolVersion[] = ["1.1", "1.0"],
): void {
  let protocolVersion: RuntimeProtocolVersion | undefined;
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
        protocolVersion = selectProtocolVersion(request, runtimeProtocolVersions);
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion,
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
      case RUNTIME_METHODS.clientCapabilitiesSet:
        assert.equal(protocolVersion, "1.2");
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: request.id,
          result: projectClientCapabilitiesSetResult(request.params),
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
  runtimeProtocolVersions: readonly RuntimeProtocolVersion[] = ["1.1", "1.0"],
): void {
  let protocolVersion: RuntimeProtocolVersion | undefined;
  transport.stdin.onFrame = (message) => {
    onClientMessage?.(message);
    if (!("method" in message) || !("id" in message)) {
      return;
    }
    if (message.method === RUNTIME_METHODS.initialize) {
      protocolVersion = selectProtocolVersion(message, runtimeProtocolVersions);
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion,
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
    if (message.method === RUNTIME_METHODS.clientCapabilitiesSet) {
      assert.equal(protocolVersion, "1.2");
      writeJson(transport.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: projectClientCapabilitiesSetResult(message.params),
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

class ControlledCapabilityRuntime {
  readonly messages: JsonRpcMessage[] = [];
  private readonly transport: MemoryTransport;
  private readonly capabilityRequests: JsonRpcRequest[] = [];
  private readonly capabilityWaiters: Array<(request: JsonRpcRequest) => void> = [];

  constructor(transport: MemoryTransport) {
    this.transport = transport;
    const reader = createInterface({ input: transport.stdin });
    reader.on("line", (line) => {
      const message = JSON.parse(line) as JsonRpcMessage;
      this.messages.push(message);
      if (!("method" in message) || !("id" in message)) {
        return;
      }
      if (message.method === RUNTIME_METHODS.initialize) {
        writeJson(transport.stdout, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "1.2",
            runtimeInstanceId: IDS.runtime,
            server: {
              name: "controlled-capability-runtime",
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
      }
      if (message.method === RUNTIME_METHODS.clientCapabilitiesSet) {
        const waiter = this.capabilityWaiters.shift();
        if (waiter === undefined) {
          this.capabilityRequests.push(message);
        } else {
          waiter(message);
        }
      }
    });
  }

  nextCapabilityRequest(): Promise<JsonRpcRequest> {
    const request = this.capabilityRequests.shift();
    if (request !== undefined) {
      return Promise.resolve(request);
    }
    return new Promise<JsonRpcRequest>((resolve) => {
      this.capabilityWaiters.push(resolve);
    });
  }

  acknowledgeCapabilityRequest(request: JsonRpcRequest): void {
    writeJson(this.transport.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      result: projectClientCapabilitiesSetResult(request.params),
    });
  }
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
    ["1.3", "1.2", "1.0"],
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
    ["1.3", "1.2", "1.1", "1.0"],
  );
  assert.equal(v11Client.getInitializationResult().protocolVersion, "1.1");
  assert.equal(
    v11Messages.some(
      (message) => "method" in message && message.method === RUNTIME_METHODS.clientCapabilitiesSet,
    ),
    false,
  );
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
    ["1.3", "1.2", "1.1", "1.0"],
  );
  assert.equal(fallbackClient.getInitializationResult().protocolVersion, "1.0");
  assert.equal(
    oldRuntimeMessages.some(
      (message) => "method" in message && message.method === RUNTIME_METHODS.clientCapabilitiesSet,
    ),
    false,
  );
  await fallbackClient.shutdown();
});

test("RollNodeClient opts out of Protocol 1.3 when its explicit frame budget is too small", async () => {
  const transport = new MemoryTransport();
  const messages: JsonRpcMessage[] = [];
  installFakeRuntime(transport, (message) => messages.push(message), ["1.3", "1.2", "1.0"]);
  const client = await RollNodeClient.connect({
    transport,
    maxFrameBytes: RUNTIME_V13_MIN_CLIENT_FRAME_BYTES - 1,
  });
  const initialize = messages.find(
    (message): message is JsonRpcRequest =>
      "method" in message && "id" in message && message.method === RUNTIME_METHODS.initialize,
  );
  assert.ok(initialize);
  assert.deepEqual(
    parseRuntimeMethodParams(RUNTIME_METHODS.initialize, initialize.params).protocolVersions,
    ["1.2", "1.0"],
  );
  assert.equal(client.getInitializationResult().protocolVersion, "1.2");
  assert.equal(client.getInitializationResult().limits.maxFrameBytes, 4 * 1_024 * 1_024);
  await client.shutdown();
});

test("RollNodeClient waits for an empty Protocol 1.2 capability ACK before connecting", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  let settled = false;
  const connecting = RollNodeClient.connect({ transport });
  connecting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  const capability = await runtime.nextCapabilityRequest();
  assert.equal(capability.method, RUNTIME_METHODS.clientCapabilitiesSet);
  assert.deepEqual(capability.params, { revision: 1, serverRequestMethods: [] });
  const initialize = runtime.messages.find(
    (message) => "method" in message && message.method === RUNTIME_METHODS.initialize,
  );
  assert.ok(initialize && "method" in initialize && "id" in initialize);
  assert.deepEqual(
    parseRuntimeMethodParams(RUNTIME_METHODS.initialize, initialize.params).protocolVersions,
    ["1.3", "1.2", "1.0"],
  );
  await flushMessages();
  assert.equal(settled, false);

  runtime.acknowledgeCapabilityRequest(capability);
  const client = await connecting;
  assert.equal(client.getInitializationResult().protocolVersion, "1.2");
  await client.shutdown();
});

test("RollNodeClient does not deliver Protocol 1.2 Server Requests before capability ACK", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  let handlerCalls = 0;
  let interactionId: string | undefined;
  const connecting = RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async (params) => {
        handlerCalls += 1;
        interactionId = "interactionId" in params ? params.interactionId : undefined;
        return { decision: "approve" };
      },
    },
  });
  const capability = await runtime.nextCapabilityRequest();
  assert.deepEqual(capability.params, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-before-capability-ack",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(),
  });
  await flushMessages();
  assert.equal(handlerCalls, 0);
  const beforeAck = findClientResponse(runtime.messages, "approval-before-capability-ack");
  assert.ok(beforeAck && "error" in beforeAck);
  assert.equal(beforeAck.error.code, -32_601);

  runtime.acknowledgeCapabilityRequest(capability);
  const client = await connecting;
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-after-capability-ack",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(IDS.interaction2),
  });
  await flushMessages();
  assert.equal(handlerCalls, 1);
  assert.equal(interactionId, IDS.interaction2);
  const afterAck = findClientResponse(runtime.messages, "approval-after-capability-ack");
  assert.ok(afterAck && "result" in afterAck);
  assert.deepEqual(afterAck.result, { decision: "approve" });
  await client.shutdown();
});

test("RollNodeClient onUserInputRequest option advertises and handles typed deployment input", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  let receivedLabel: string | undefined;
  let receivedRequestId: string | number | undefined;
  const handler: UserInputRequestHandler = async (params, context) => {
    receivedLabel = params.controls[0]?.label;
    receivedRequestId = context.requestId;
    return {
      status: "submitted",
      values: [{ id: "deployment-region", value: "华东" }],
    };
  };
  const connecting = RollNodeClient.connect({
    transport,
    onUserInputRequest: handler,
  });
  const capability = await runtime.nextCapabilityRequest();
  assert.deepEqual(capability.params, {
    revision: 1,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest],
  });
  runtime.acknowledgeCapabilityRequest(capability);
  const client = await connecting;

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "deployment-region-request",
    method: RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
    params: deploymentRegionRequestParamsV12(),
  });
  await flushMessages();
  assert.equal(receivedLabel, "部署区域");
  assert.equal(receivedRequestId, "deployment-region-request");
  const response = findClientResponse(runtime.messages, "deployment-region-request");
  assert.ok(response && "result" in response);
  assert.deepEqual(response.result, {
    status: "submitted",
    values: [{ id: "deployment-region", value: "华东" }],
  });
  await client.shutdown();
});

test("RollNodeClient onUserInputRequest method dynamically registers target Workspace input", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  const connecting = RollNodeClient.connect({ transport });
  const initialCapability = await runtime.nextCapabilityRequest();
  runtime.acknowledgeCapabilityRequest(initialCapability);
  const client = await connecting;

  let selectedControlId: string | undefined;
  const unregister = client.onUserInputRequest(async (params) => {
    selectedControlId = params.controls[0]?.id;
    return {
      status: "submitted",
      values: [{ id: "target-workspace", value: "workspace-b" }],
    };
  });
  const addCapability = await runtime.nextCapabilityRequest();
  assert.deepEqual(addCapability.params, {
    revision: 2,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest],
  });
  runtime.acknowledgeCapabilityRequest(addCapability);
  await flushMessages();

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "target-workspace-request",
    method: RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
    params: targetWorkspaceRequestParamsV12(),
  });
  await flushMessages();
  assert.equal(selectedControlId, "target-workspace");
  const response = findClientResponse(runtime.messages, "target-workspace-request");
  assert.ok(response && "result" in response);
  assert.deepEqual(response.result, {
    status: "submitted",
    values: [{ id: "target-workspace", value: "workspace-b" }],
  });

  unregister();
  const removeCapability = await runtime.nextCapabilityRequest();
  assert.deepEqual(removeCapability.params, { revision: 3, serverRequestMethods: [] });
  runtime.acknowledgeCapabilityRequest(removeCapability);
  await flushMessages();
  await client.shutdown();
});

test("RollNodeClient applies a Protocol 1.2 capability ACK before the next line in one chunk", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  let handlerCalls = 0;
  const connecting = RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => {
        handlerCalls += 1;
        return { decision: "approve" };
      },
    },
  });
  const capability = await runtime.nextCapabilityRequest();
  writeJsonChunk(transport.stdout, [
    {
      jsonrpc: "2.0",
      id: capability.id,
      result: projectClientCapabilitiesSetResult(capability.params),
    },
    {
      jsonrpc: "2.0",
      id: "approval-after-same-chunk-capability-ack",
      method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      params: approvalRequestParamsV12(),
    },
  ]);

  const client = await connecting;
  await flushMessages();
  assert.equal(handlerCalls, 1);
  const response = findClientResponse(runtime.messages, "approval-after-same-chunk-capability-ack");
  assert.ok(response && "result" in response);
  assert.deepEqual(response.result, { decision: "approve" });
  await client.shutdown();
});

test("RollNodeClient accepts a Protocol 1.1 request after initialize in one chunk", async () => {
  const transport = new MemoryTransport();
  const messages: JsonRpcMessage[] = [];
  let handlerCalls = 0;
  const reader = createInterface({ input: transport.stdin });
  reader.on("line", (line) => {
    const message = JSON.parse(line) as JsonRpcMessage;
    messages.push(message);
    if (
      !("method" in message) ||
      !("id" in message) ||
      message.method !== RUNTIME_METHODS.initialize
    ) {
      return;
    }
    writeJsonChunk(transport.stdout, [
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "1.1",
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "same-chunk-v11-runtime",
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
      },
      {
        jsonrpc: "2.0",
        id: "approval-after-same-chunk-initialize",
        method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
        params: approvalRequestParams(),
      },
    ]);
  });

  const client = await RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => {
        handlerCalls += 1;
        return { decision: "approve" };
      },
    },
  });
  await flushMessages();
  assert.equal(client.getInitializationResult().protocolVersion, "1.1");
  assert.equal(handlerCalls, 1);
  const response = findClientResponse(messages, "approval-after-same-chunk-initialize");
  assert.ok(response && "result" in response);
  assert.deepEqual(response.result, { decision: "approve" });
  await client.shutdown();
});

test("RollNodeClient preserves Protocol 1.2 pendingInteractions in thread.snapshot", async () => {
  const transport = new MemoryTransport();
  installThreadSnapshotRuntime(transport, "1.2", {
    ...threadSnapshotResult(),
    pendingInteractions: [
      {
        method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
        interactionId: IDS.interaction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        expiresAt: "2026-07-29T12:10:00.000Z",
        sensitivity: "normal",
        approvalId: IDS.approval,
      },
    ],
  });
  const client = await RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
        decision: "approve",
      }),
    },
  });

  const snapshot = await client.request(RUNTIME_METHODS.threadSnapshot, {
    threadId: IDS.thread,
  });
  assert.ok("pendingInteractions" in snapshot);
  if (!("pendingInteractions" in snapshot)) {
    assert.fail("Protocol 1.2 snapshot lost pendingInteractions");
  }
  assert.equal(snapshot.pendingInteractions[0]?.interactionId, IDS.interaction);
  await client.shutdown();
});

test("RollNodeClient parses Protocol 1.1 and 1.0 snapshots with their frozen shape", async () => {
  for (const protocolVersion of ["1.1", "1.0"] as const) {
    const transport = new MemoryTransport();
    installThreadSnapshotRuntime(transport, protocolVersion, threadSnapshotResult());
    const client = await RollNodeClient.connect({
      transport,
      serverRequestHandlers: {
        [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
          decision: "approve",
        }),
      },
    });

    const snapshot = await client.request(RUNTIME_METHODS.threadSnapshot, {
      threadId: IDS.thread,
    });
    assert.equal(client.getInitializationResult().protocolVersion, protocolVersion);
    assert.equal("pendingInteractions" in snapshot, false);
    assert.deepEqual(snapshot.pendingApprovals, []);
    await client.shutdown();
  }
});

test("RollNodeClient serializes Protocol 1.2 capability revisions and keeps replacements local", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  const connecting = RollNodeClient.connect({ transport });
  const initialCapability = await runtime.nextCapabilityRequest();
  runtime.acknowledgeCapabilityRequest(initialCapability);
  const client = await connecting;

  let firstHandlerCalls = 0;
  const unregisterFirst = client.registerServerRequestHandler(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    async () => {
      firstHandlerCalls += 1;
      return { decision: "approve" };
    },
  );
  const addedCapability = await runtime.nextCapabilityRequest();
  assert.deepEqual(addedCapability.params, {
    revision: 2,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  runtime.acknowledgeCapabilityRequest(addedCapability);
  await flushMessages();

  let replacementHandlerCalls = 0;
  const unregisterReplacement = client.registerServerRequestHandler(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    async () => {
      replacementHandlerCalls += 1;
      return { decision: "reject", reason: "replacement" };
    },
  );
  unregisterFirst();
  await flushMessages();
  assert.equal(
    runtime.messages.filter(
      (message) => "method" in message && message.method === RUNTIME_METHODS.clientCapabilitiesSet,
    ).length,
    2,
  );

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-after-replacement",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(),
  });
  await flushMessages();
  assert.equal(firstHandlerCalls, 0);
  assert.equal(replacementHandlerCalls, 1);
  const replacement = findClientResponse(runtime.messages, "approval-after-replacement");
  assert.ok(replacement && "result" in replacement);
  assert.deepEqual(replacement.result, { decision: "reject", reason: "replacement" });

  unregisterReplacement();
  const removedCapability = await runtime.nextCapabilityRequest();
  assert.deepEqual(removedCapability.params, { revision: 3, serverRequestMethods: [] });
  runtime.acknowledgeCapabilityRequest(removedCapability);
  await flushMessages();
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-after-removal",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(IDS.interaction2),
  });
  await flushMessages();
  const removed = findClientResponse(runtime.messages, "approval-after-removal");
  assert.ok(removed && "error" in removed);
  assert.equal(removed.error.code, -32_601);
  await client.shutdown();
});

test("RollNodeClient preserves ordered snapshots across rapid capability withdrawal and re-add", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  const connecting = RollNodeClient.connect({ transport });
  const initialCapability = await runtime.nextCapabilityRequest();
  runtime.acknowledgeCapabilityRequest(initialCapability);
  const client = await connecting;

  const unregisterFirst = client.registerServerRequestHandler(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    async () => ({ decision: "approve" }),
  );
  const add = await runtime.nextCapabilityRequest();
  assert.deepEqual(add.params, {
    revision: 2,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  unregisterFirst();
  let replacementCalls = 0;
  const unregisterReplacement = client.registerServerRequestHandler(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    async () => {
      replacementCalls += 1;
      return { decision: "approve" };
    },
  );
  await flushMessages();
  assert.equal(
    runtime.messages.filter(
      (message) => "method" in message && message.method === RUNTIME_METHODS.clientCapabilitiesSet,
    ).length,
    2,
  );

  runtime.acknowledgeCapabilityRequest(add);
  const remove = await runtime.nextCapabilityRequest();
  assert.deepEqual(remove.params, { revision: 3, serverRequestMethods: [] });
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-before-rapid-remove-ack",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(IDS.interaction),
  });
  await flushMessages();
  assert.equal(replacementCalls, 0);
  const beforeRemoveAck = findClientResponse(runtime.messages, "approval-before-rapid-remove-ack");
  assert.ok(beforeRemoveAck && "error" in beforeRemoveAck);
  assert.equal(beforeRemoveAck.error.code, -32_601);

  runtime.acknowledgeCapabilityRequest(remove);
  const readd = await runtime.nextCapabilityRequest();
  assert.deepEqual(readd.params, {
    revision: 4,
    serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-before-rapid-readd-ack",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(IDS.interaction2),
  });
  await flushMessages();
  assert.equal(replacementCalls, 0);
  const beforeReaddAck = findClientResponse(runtime.messages, "approval-before-rapid-readd-ack");
  assert.ok(beforeReaddAck && "error" in beforeReaddAck);
  assert.equal(beforeReaddAck.error.code, -32_601);

  runtime.acknowledgeCapabilityRequest(readd);
  await flushMessages();

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-after-rapid-readd",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(IDS.interaction3),
  });
  await flushMessages();
  assert.equal(replacementCalls, 1);
  const response = findClientResponse(runtime.messages, "approval-after-rapid-readd");
  assert.ok(response && "result" in response);
  unregisterReplacement();
  const finalRemove = await runtime.nextCapabilityRequest();
  runtime.acknowledgeCapabilityRequest(finalRemove);
  await flushMessages();
  await client.shutdown();
});

test("RollNodeClient withdrawal immediately aborts Protocol 1.2 requests and suppresses late results", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  const connecting = RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
        decision: "approve",
      }),
    },
  });
  const initialCapability = await runtime.nextCapabilityRequest();
  runtime.acknowledgeCapabilityRequest(initialCapability);
  const client = await connecting;

  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveHandler!: (result: { decision: "approve" }) => void;
  let signal: AbortSignal | undefined;
  const unregister = client.registerServerRequestHandler(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    async (_params, context) => {
      signal = context.signal;
      resolveStarted();
      return await new Promise<{ decision: "approve" }>((resolve) => {
        resolveHandler = resolve;
      });
    },
  );
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-withdrawn",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(),
  });
  await started;

  unregister();
  assert.equal(signal?.aborted, true);
  const removedCapability = await runtime.nextCapabilityRequest();
  assert.deepEqual(removedCapability.params, { revision: 2, serverRequestMethods: [] });
  resolveHandler({ decision: "approve" });
  await flushMessages();
  assert.equal(findClientResponse(runtime.messages, "approval-withdrawn"), undefined);

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    params: { interactionId: IDS.interaction, reason: "capability-withdrawn" },
  });
  runtime.acknowledgeCapabilityRequest(removedCapability);
  await flushMessages();
  assert.equal(findClientResponse(runtime.messages, "approval-withdrawn"), undefined);
  await client.shutdown();
});

test("RollNodeClient correlates Protocol 1.2 cancellation only by interactionId", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveHandler!: (result: { decision: "approve" }) => void;
  let signal: AbortSignal | undefined;
  const connecting = RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async (_params, context) => {
        signal = context.signal;
        resolveStarted();
        return await new Promise<{ decision: "approve" }>((resolve) => {
          resolveHandler = resolve;
        });
      },
    },
  });
  const capability = await runtime.nextCapabilityRequest();
  runtime.acknowledgeCapabilityRequest(capability);
  const client = await connecting;
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "approval-json-rpc-id",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(),
  });
  await started;

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    params: { interactionId: IDS.interaction2, reason: "wrong-interaction" },
  });
  await flushMessages();
  assert.equal(signal?.aborted, false);
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    params: { interactionId: IDS.interaction, reason: "turn-cancelled" },
  });
  await flushMessages();
  assert.equal(signal?.aborted, true);
  resolveHandler({ decision: "approve" });
  await flushMessages();
  assert.equal(findClientResponse(runtime.messages, "approval-json-rpc-id"), undefined);

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    params: { interactionId: IDS.interaction, reason: "late-duplicate" },
  });
  await flushMessages();
  await client.shutdown();
});

test("RollNodeClient parses Protocol 1.2 capability conflicts as structured RPC errors", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  const connecting = RollNodeClient.connect({ transport });
  const initialCapability = await runtime.nextCapabilityRequest();
  runtime.acknowledgeCapabilityRequest(initialCapability);
  const client = await connecting;
  const exited = new Promise<RuntimeClientExit>((resolve) => client.onExit(resolve));
  client.registerServerRequestHandler(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, async () => ({
    decision: "approve",
  }));
  const capability = await runtime.nextCapabilityRequest();
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: capability.id,
    error: {
      code: -32_000,
      message: "capability revision conflict",
      data: { rollCode: "CAPABILITY_REVISION_CONFLICT", retryable: false },
    },
  });
  const result = await exited;
  assert.ok(result.error instanceof RollRpcError);
  assert.equal(result.error.data?.rollCode, "CAPABILITY_REVISION_CONFLICT");
  assert.equal((await client.shutdown()).error, result.error);
});

test("RollNodeClient rejects a mismatched Protocol 1.2 capability ACK revision", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  const connecting = RollNodeClient.connect({ transport });
  const capability = await runtime.nextCapabilityRequest();
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: capability.id,
    result: { revision: 2, acceptedServerRequestMethods: [] },
  });
  await assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof RollProtocolViolationError);
    assert.match(error.message, /expected 1/u);
    return true;
  });
});

test("RollNodeClient accepts a Protocol 1.2 subset capability ACK and answers dropped methods with -32601", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  let approvalCalls = 0;
  let userInputCalls = 0;
  const connecting = RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => {
        approvalCalls += 1;
        return { decision: "approve" };
      },
      [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest]: async () => {
        userInputCalls += 1;
        return { status: "cancelled" };
      },
    },
  });
  const capability = await runtime.nextCapabilityRequest();
  assert.deepEqual(capability.params, {
    revision: 1,
    serverRequestMethods: [
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
    ],
  });
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: capability.id,
    result: {
      revision: 1,
      acceptedServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
    },
  });
  const client = await connecting;

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "dropped-user-input-request",
    method: RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
    params: deploymentRegionRequestParamsV12(),
  });
  await flushMessages();
  const dropped = findClientResponse(runtime.messages, "dropped-user-input-request");
  assert.ok(dropped && "error" in dropped);
  assert.equal(dropped.error.code, -32_601);
  assert.equal(userInputCalls, 0);

  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "accepted-approval-request",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(),
  });
  await flushMessages();
  const approved = findClientResponse(runtime.messages, "accepted-approval-request");
  assert.ok(approved && "result" in approved);
  assert.deepEqual(approved.result, { decision: "approve" });
  assert.equal(approvalCalls, 1);
  await client.shutdown();
});

test("RollNodeClient accepts a reordered Protocol 1.2 capability ACK", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  let approvalCalls = 0;
  const connecting = RollNodeClient.connect({
    transport,
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => {
        approvalCalls += 1;
        return { decision: "approve" };
      },
      [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest]: async () => ({ status: "cancelled" }),
    },
  });
  const capability = await runtime.nextCapabilityRequest();
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: capability.id,
    result: {
      revision: 1,
      acceptedServerRequestMethods: [
        RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
        RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      ],
    },
  });
  const client = await connecting;
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: "reordered-approval-request",
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params: approvalRequestParamsV12(),
  });
  await flushMessages();
  const approved = findClientResponse(runtime.messages, "reordered-approval-request");
  assert.ok(approved && "result" in approved);
  assert.deepEqual(approved.result, { decision: "approve" });
  assert.equal(approvalCalls, 1);
  await client.shutdown();
});

test("RollNodeClient rejects a capability ACK containing an unrequested method", async () => {
  const transport = new MemoryTransport();
  const runtime = new ControlledCapabilityRuntime(transport);
  const connecting = RollNodeClient.connect({ transport });
  const capability = await runtime.nextCapabilityRequest();
  assert.deepEqual(capability.params, { revision: 1, serverRequestMethods: [] });
  writeJson(transport.stdout, {
    jsonrpc: "2.0",
    id: capability.id,
    result: {
      revision: 1,
      acceptedServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
    },
  });
  await assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof RollProtocolViolationError);
    assert.match(error.message, /not requested/u);
    return true;
  });
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
      ["1.3", "1.2", "1.0"],
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
      '      protocolVersion: "1.0",',
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
