import assert from "node:assert/strict";
import { test } from "node:test";
import { RollRpcError } from "@roll-agent/client-node";
import {
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  parseRuntimeMethodParams,
  parseRuntimeMethodResult,
  runtimeEventEnvelopeSchema,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodInput,
  type RuntimeMethodResult,
  type JsonValue,
} from "@roll-agent/protocol";
import {
  CompanionWorkspace,
  LocalConfirmationRequiredError,
  type CompanionRuntimeClient,
  type LocalApprovalDecision,
} from "./companion-workspace.ts";
import { CompanionEventBuffer } from "./event-buffer.ts";
import {
  CompanionRelayBridge,
  OutboundCompanionRelay,
  type RelayPayloadCipher,
  type RelayTransport,
} from "./relay-bridge.ts";
import {
  COMPANION_RELAY_PROTOCOL_VERSION,
  deviceIdSchema,
  relayDeviceConnectSchema,
  relayMessageSchema,
  relayRuntimeRequestSchema,
  workspaceIdSchema,
  type RelayEncryptedMessage,
  type RelayMessage,
} from "./relay-protocol.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000401",
  thread: "00000000-0000-4000-8000-000000000402",
  turn: "00000000-0000-4000-8000-000000000403",
  approval: "00000000-0000-4000-8000-000000000404",
  requestStart: "00000000-0000-4000-8000-000000000405",
  requestApproval: "00000000-0000-4000-8000-000000000406",
  device: "00000000-0000-4000-8000-000000000407",
  workspace: "00000000-0000-4000-8000-000000000408",
  relayRequest: "00000000-0000-4000-8000-000000000409",
  secondTurn: "00000000-0000-4000-8000-000000000411",
  secondRequestStart: "00000000-0000-4000-8000-000000000412",
  relaySnapshotRequest: "00000000-0000-4000-8000-000000000413",
  relaySecondRequest: "00000000-0000-4000-8000-000000000414",
  relayThirdRequest: "00000000-0000-4000-8000-000000000415",
  thirdTurn: "00000000-0000-4000-8000-000000000416",
  thirdRequestStart: "00000000-0000-4000-8000-000000000417",
} as const;

function envelope(sequence: number, event: unknown): RuntimeEventEnvelope {
  return runtimeEventEnvelopeSchema.parse({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: IDS.runtime,
    sequence,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event,
  });
}

class FakeRuntimeClient implements CompanionRuntimeClient {
  readonly requests: Array<{ readonly method: RuntimeMethod; readonly input: unknown }> = [];
  closeCalls = 0;
  shutdownCalls = 0;
  private readonly listeners = new Set<(event: RuntimeEventEnvelope) => void>();

  async request<TMethod extends RuntimeMethod>(
    method: TMethod,
    input: RuntimeMethodInput<TMethod>,
  ): Promise<RuntimeMethodResult<TMethod>> {
    this.requests.push({ method, input });
    if (method === RUNTIME_METHODS.turnStart) {
      const params = parseRuntimeMethodParams(RUNTIME_METHODS.turnStart, input);
      return parseRuntimeMethodResult(method, {
        accepted: true,
        turnId: params.turnId,
      });
    }
    if (method === RUNTIME_METHODS.approvalRespond) {
      return parseRuntimeMethodResult(method, { resolved: true });
    }
    if (method === RUNTIME_METHODS.threadSnapshot) {
      return parseRuntimeMethodResult(method, {
        thread: {
          id: IDS.thread,
          title: "Companion fixture",
          model: "fixture-model",
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:01:00.000Z",
          messageCount: 0,
        },
        messages: { items: [], nextBeforeSequence: null },
        operations: { items: [], nextBeforeSequence: null },
        pendingApprovals: [],
        transcriptCompleteness: "complete",
      });
    }
    throw new Error(`Unexpected fake request: ${method}`);
  }

  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.closeCalls += 1;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }

  emit(event: RuntimeEventEnvelope): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class DeferredTurnRuntimeClient extends FakeRuntimeClient {
  private releasePendingRequest: (() => void) | undefined;
  private readonly pendingRequest = new Promise<void>((resolve) => {
    this.releasePendingRequest = resolve;
  });

  override async request<TMethod extends RuntimeMethod>(
    method: TMethod,
    input: RuntimeMethodInput<TMethod>,
  ): Promise<RuntimeMethodResult<TMethod>> {
    if (method !== RUNTIME_METHODS.turnStart) {
      return super.request(method, input);
    }
    this.requests.push({ method, input });
    const params = parseRuntimeMethodParams(RUNTIME_METHODS.turnStart, input);
    if (params.turnId === IDS.turn) {
      await this.pendingRequest;
    }
    return parseRuntimeMethodResult(method, {
      accepted: true,
      turnId: params.turnId,
    });
  }

  release(): void {
    this.releasePendingRequest?.();
    this.releasePendingRequest = undefined;
  }
}

class FailingRuntimeClient implements CompanionRuntimeClient {
  async request<TMethod extends RuntimeMethod>(
    _method: TMethod,
    _input: RuntimeMethodInput<TMethod>,
  ): Promise<RuntimeMethodResult<TMethod>> {
    throw new RollRpcError({
      code: -32_000,
      message: "runtime is closing",
      data: {
        rollCode: "RUNTIME_CLOSING",
        retryable: true,
      },
    });
  }

  onEvent(_listener: (event: RuntimeEventEnvelope) => void): () => void {
    return () => {};
  }

  close(): void {}
}

class MemoryRelayTransport implements RelayTransport {
  readonly sent: RelayMessage[] = [];
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();

  send(message: RelayMessage): void {
    this.sent.push(relayMessageSchema.parse(message));
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    this.disconnect();
  }

  receive(message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  disconnect(): void {
    for (const listener of [...this.closeListeners]) {
      listener();
    }
  }
}

class StuckRelayTransport extends MemoryRelayTransport {
  override send(message: RelayMessage): Promise<void> {
    super.send(message);
    return new Promise<void>(() => {});
  }
}

interface RelayRequestCacheView {
  readonly inFlightRequestCache: ReadonlyMap<
    string,
    { readonly fingerprint: string; readonly response: Promise<unknown> }
  >;
  readonly settledRequestCache: ReadonlyMap<
    string,
    { readonly fingerprint: string; readonly response: Promise<unknown> }
  >;
}

const testCipher: RelayPayloadCipher = {
  algorithm: "test-only-base64",
  async encrypt(value) {
    return {
      nonce: "test-nonce",
      ciphertext: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
    };
  },
  async decrypt(message) {
    return JSON.parse(Buffer.from(message.ciphertext, "base64").toString("utf8")) as JsonValue;
  },
};

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function turnRelayRequest(
  relayRequestId: string,
  runtimeRequestId: string,
  turnId: string,
  text: string,
) {
  return relayRuntimeRequestSchema.parse({
    type: "runtime.request",
    requestId: relayRequestId,
    workspaceId: IDS.workspace,
    method: RUNTIME_METHODS.turnStart,
    params: {
      requestId: runtimeRequestId,
      threadId: IDS.thread,
      turnId,
      input: { text },
    },
  });
}

test("CompanionEventBuffer emits a gap after count/byte eviction and supports ACK", () => {
  const buffer = new CompanionEventBuffer({ maxEvents: 2, maxBytes: 1_000_000 });
  buffer.append(envelope(0, { type: "turn.started" }));
  buffer.append(envelope(1, { type: "turn.completed" }));
  buffer.append(envelope(2, { type: "turn.completed" }));

  assert.deepEqual(buffer.replay(-1), {
    gap: { fromRelaySequence: 0, throughRelaySequence: 0 },
    events: [
      { relaySequence: 1, event: envelope(1, { type: "turn.completed" }) },
      { relaySequence: 2, event: envelope(2, { type: "turn.completed" }) },
    ],
  });
  buffer.acknowledge(1);
  assert.equal(buffer.size, 1);
  assert.deepEqual(
    buffer.replay(1).events.map((entry) => entry.relaySequence),
    [2],
  );
  buffer.acknowledge(99);
  assert.equal(buffer.size, 1);
});

test("CompanionWorkspace keeps local leases and local policy authoritative", async () => {
  const client = new FakeRuntimeClient();
  let decision: LocalApprovalDecision = "require-local-confirmation";
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => decision,
    maxEvents: 10,
  });
  workspace.attachBrowser("browser-1");
  await workspace.startTurn({
    requestId: IDS.requestStart,
    threadId: IDS.thread,
    turnId: IDS.turn,
    input: { text: "remote request" },
  });
  assert.equal(workspace.detachBrowser("browser-1"), true);
  assert.equal(workspace.leases.canStopRuntime(), false);

  client.emit(
    envelope(0, {
      type: "approval.required",
      approval: {
        id: IDS.approval,
        turnId: IDS.turn,
        agentName: "demo-agent",
        toolName: "dangerous-write",
        preview: { path: "/tmp/demo" },
      },
    }),
  );
  await assert.rejects(
    workspace.respondApproval({
      requestId: IDS.requestApproval,
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    LocalConfirmationRequiredError,
  );
  assert.equal(
    client.requests.filter((request) => request.method === RUNTIME_METHODS.approvalRespond).length,
    0,
  );

  decision = "allow";
  assert.equal(
    (
      await workspace.respondApproval({
        requestId: IDS.requestApproval,
        threadId: IDS.thread,
        turnId: IDS.turn,
        approvalId: IDS.approval,
        decision: "approve",
      })
    ).resolved,
    true,
  );
  const releaseShell = workspace.acquireBackgroundShellLease("shell-1");
  client.emit(envelope(1, { type: "turn.completed" }));
  assert.equal(await workspace.closeIfIdle(), false);
  releaseShell();
  assert.equal(await workspace.closeIfIdle(), true);
  assert.equal(client.shutdownCalls, 1);
  assert.equal(client.closeCalls, 0);
});

test("Companion Relay Protocol remains separate from Runtime Protocol", () => {
  assert.equal(
    relayDeviceConnectSchema.parse({
      type: "device.connect",
      protocolVersion: COMPANION_RELAY_PROTOCOL_VERSION,
      deviceId: IDS.device,
      pairingToken: "pairing-token-with-sufficient-length",
    }).type,
    "device.connect",
  );
  const request = relayRuntimeRequestSchema.parse({
    type: "runtime.request",
    requestId: IDS.relayRequest,
    workspaceId: IDS.workspace,
    method: RUNTIME_METHODS.threadSnapshot,
    params: { threadId: IDS.thread, limit: 100 },
  });
  assert.equal(request.method, "thread.snapshot");
});

test("CompanionRelayBridge routes requests outbound and replays unacked events after reconnect", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
  });
  const first = new MemoryRelayTransport();
  bridge.connect(first);
  await flush();
  assert.equal(first.sent[0]?.type, "device.connect");

  first.receive({
    type: "runtime.request",
    requestId: IDS.relayRequest,
    workspaceId,
    method: RUNTIME_METHODS.turnStart,
    params: {
      requestId: IDS.requestStart,
      threadId: IDS.thread,
      turnId: IDS.turn,
      input: { text: "from relay" },
    },
  });
  await flush();
  assert.equal(
    first.sent.some(
      (message) => message.type === "runtime.response" && message.result !== undefined,
    ),
    true,
  );

  client.emit(envelope(0, { type: "turn.completed" }));
  await flush();
  const firstEvent = first.sent.find((message) => message.type === "runtime.event");
  assert.ok(firstEvent?.type === "runtime.event");
  first.receive({
    type: "runtime.ack",
    workspaceId,
    throughRelaySequence: firstEvent.relaySequence,
  });
  await flush();
  first.disconnect();
  client.emit(envelope(1, { type: "capabilities.changed" }));

  const second = new MemoryRelayTransport();
  bridge.connect(second);
  await flush();
  assert.equal(second.sent[0]?.type, "device.connect");
  assert.deepEqual(
    second.sent
      .filter((message) => message.type === "runtime.event")
      .map((message) => message.relaySequence),
    [1],
  );
  bridge.close();
});

test("CompanionRelayBridge ignores ACKs beyond the sequence advertised on that transport", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
  });
  const first = new MemoryRelayTransport();
  bridge.connect(first);
  await flush();

  first.receive({
    type: "runtime.ack",
    workspaceId,
    throughRelaySequence: 100,
  });
  await flush();
  client.emit(envelope(0, { type: "capabilities.changed" }));
  await flush();
  first.disconnect();

  const second = new MemoryRelayTransport();
  bridge.connect(second);
  await flush();
  assert.deepEqual(
    second.sent
      .filter((message) => message.type === "runtime.event")
      .map((message) => message.relaySequence),
    [0],
  );
  bridge.close();
});

test("CompanionRelayBridge isolates a new transport from a stuck old send queue", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
  });
  client.emit(envelope(0, { type: "capabilities.changed" }));

  const stuck = new StuckRelayTransport();
  bridge.connect(stuck);
  await flush();
  assert.deepEqual(
    stuck.sent.map((message) => message.type),
    ["device.connect"],
  );
  stuck.receive({
    type: "runtime.ack",
    workspaceId,
    throughRelaySequence: 0,
  });
  await flush();

  const current = new MemoryRelayTransport();
  bridge.connect(current);
  await flush();
  assert.equal(current.sent[0]?.type, "device.connect");
  assert.deepEqual(
    current.sent
      .filter((message) => message.type === "runtime.event")
      .map((message) => message.relaySequence),
    [0],
  );
  bridge.close();
});

test("CompanionRelayBridge supports opaque per-workspace E2E payload ciphers", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
    ciphers: new Map([[workspaceId, testCipher]]),
  });
  const transport = new MemoryRelayTransport();
  bridge.connect(transport);
  await flush();

  const innerRequest = relayRuntimeRequestSchema.parse({
    type: "runtime.request",
    requestId: IDS.relayRequest,
    workspaceId,
    method: RUNTIME_METHODS.turnStart,
    params: {
      requestId: IDS.requestStart,
      threadId: IDS.thread,
      turnId: IDS.turn,
      input: { text: "encrypted request" },
    },
  });
  const encrypted = await testCipher.encrypt(innerRequest);
  transport.receive({
    type: "runtime.encrypted",
    workspaceId,
    envelopeId: "00000000-0000-4000-8000-000000000410",
    payloadKind: "request",
    requestId: IDS.relayRequest,
    algorithm: testCipher.algorithm,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
  });
  await flush();
  const encryptedResponse = transport.sent.find(
    (message): message is RelayEncryptedMessage =>
      message.type === "runtime.encrypted" && message.payloadKind === "response",
  );
  assert.ok(encryptedResponse !== undefined);
  const decryptedResponse = await testCipher.decrypt(encryptedResponse);
  assert.equal(
    typeof decryptedResponse === "object" &&
      decryptedResponse !== null &&
      !Array.isArray(decryptedResponse) &&
      decryptedResponse.type === "runtime.response",
    true,
  );

  client.emit(envelope(0, { type: "turn.completed" }));
  await flush();
  assert.equal(
    transport.sent.some(
      (message) => message.type === "runtime.encrypted" && message.payloadKind === "event",
    ),
    true,
  );
  assert.equal(
    transport.sent.some((message) => message.type === "runtime.event"),
    false,
  );
  bridge.close();
});

test("CompanionRelayBridge deduplicates Relay requests before invoking Runtime", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
  });
  const transport = new MemoryRelayTransport();
  bridge.connect(transport);
  await flush();
  const largeInput = "deduplicate me ".repeat(64 * 1_024);
  const request = turnRelayRequest(IDS.relayRequest, IDS.requestStart, IDS.turn, largeInput);

  transport.receive(request);
  transport.receive(request);
  await flush();
  assert.equal(
    client.requests.filter((entry) => entry.method === RUNTIME_METHODS.turnStart).length,
    1,
  );
  assert.equal(
    transport.sent.filter(
      (message) => message.type === "runtime.response" && message.requestId === IDS.relayRequest,
    ).length,
    2,
  );
  const cache = bridge as unknown as RelayRequestCacheView;
  const fingerprints = [...cache.settledRequestCache.values()].map((entry) => entry.fingerprint);
  assert.equal(cache.inFlightRequestCache.size, 0);
  assert.deepEqual(
    fingerprints.map((fingerprint) => fingerprint.length),
    [64],
  );
  assert.equal(fingerprints[0]?.includes(largeInput), false);

  transport.receive({
    ...request,
    params: {
      requestId: IDS.secondRequestStart,
      threadId: IDS.thread,
      turnId: IDS.secondTurn,
      input: { text: "conflicting replay" },
    },
  });
  await flush();
  const conflict = transport.sent.find(
    (message) =>
      message.type === "runtime.response" &&
      message.requestId === IDS.relayRequest &&
      message.error?.code === "RELAY_REQUEST_ID_CONFLICT",
  );
  assert.ok(conflict !== undefined);
  assert.equal(
    client.requests.filter((entry) => entry.method === RUNTIME_METHODS.turnStart).length,
    1,
  );
  bridge.close();
});

test("CompanionRelayBridge does not retain read-only Snapshot requests", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
  });
  const transport = new MemoryRelayTransport();
  bridge.connect(transport);
  await flush();
  const request = relayRuntimeRequestSchema.parse({
    type: "runtime.request",
    requestId: IDS.relaySnapshotRequest,
    workspaceId,
    method: RUNTIME_METHODS.threadSnapshot,
    params: { threadId: IDS.thread, limit: 100 },
  });

  transport.receive(request);
  transport.receive(request);
  await flush();

  assert.equal(
    client.requests.filter((entry) => entry.method === RUNTIME_METHODS.threadSnapshot).length,
    2,
  );
  const cache = bridge as unknown as RelayRequestCacheView;
  assert.equal(cache.inFlightRequestCache.size, 0);
  assert.equal(cache.settledRequestCache.size, 0);
  bridge.close();
});

test("CompanionRelayBridge keeps a settled-response LRU independent of in-flight requests", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
    maxRequestCacheEntries: 2,
  });
  const transport = new MemoryRelayTransport();
  bridge.connect(transport);
  await flush();
  const first = turnRelayRequest(IDS.relayRequest, IDS.requestStart, IDS.turn, "first");
  const second = turnRelayRequest(
    IDS.relaySecondRequest,
    IDS.secondRequestStart,
    IDS.secondTurn,
    "second",
  );
  const third = turnRelayRequest(
    IDS.relayThirdRequest,
    IDS.thirdRequestStart,
    IDS.thirdTurn,
    "third",
  );

  transport.receive(first);
  await flush();
  transport.receive(second);
  await flush();
  transport.receive(first);
  await flush();
  transport.receive(third);
  await flush();
  transport.receive(second);
  await flush();

  assert.equal(
    client.requests.filter((entry) => entry.method === RUNTIME_METHODS.turnStart).length,
    4,
  );
  const cache = bridge as unknown as RelayRequestCacheView;
  assert.equal(cache.inFlightRequestCache.size, 0);
  assert.equal(cache.settledRequestCache.size, 2);
  bridge.close();
});

test("CompanionRelayBridge never charges in-flight mutations against the settled LRU", async () => {
  const client = new DeferredTurnRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
    maxRequestCacheEntries: 1,
  });
  const transport = new MemoryRelayTransport();
  bridge.connect(transport);
  await flush();
  const pending = turnRelayRequest(IDS.relayRequest, IDS.requestStart, IDS.turn, "pending");
  const settled = turnRelayRequest(
    IDS.relaySecondRequest,
    IDS.secondRequestStart,
    IDS.secondTurn,
    "settled",
  );

  transport.receive(pending);
  await flush();
  transport.receive(settled);
  await flush();
  transport.receive(pending);
  transport.receive(settled);
  await flush();
  assert.equal(
    client.requests.filter((entry) => entry.method === RUNTIME_METHODS.turnStart).length,
    2,
  );

  const cacheBeforeRelease = bridge as unknown as RelayRequestCacheView;
  assert.equal(cacheBeforeRelease.inFlightRequestCache.size, 1);
  assert.equal(cacheBeforeRelease.settledRequestCache.size, 1);

  client.release();
  await flush();
  transport.receive(settled);
  await flush();
  assert.equal(
    client.requests.filter((entry) => entry.method === RUNTIME_METHODS.turnStart).length,
    3,
  );
  bridge.close();
});

test("CompanionRelayBridge preserves stable Runtime error semantics", async () => {
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const workspace = new CompanionWorkspace({
    client: new FailingRuntimeClient(),
    localApprovalPolicy: () => "allow",
  });
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
  });
  const transport = new MemoryRelayTransport();
  bridge.connect(transport);
  await flush();
  transport.receive({
    type: "runtime.request",
    requestId: IDS.relayRequest,
    workspaceId,
    method: RUNTIME_METHODS.threadSnapshot,
    params: { threadId: IDS.thread, limit: 100 },
  });
  await flush();

  const response = transport.sent.find(
    (message) => message.type === "runtime.response" && message.requestId === IDS.relayRequest,
  );
  assert.equal(response?.type, "runtime.response");
  assert.deepEqual(response?.type === "runtime.response" ? response.error : undefined, {
    code: "RUNTIME_CLOSING",
    message: "runtime is closing",
    retryable: true,
  });
  bridge.close();
});

test("OutboundCompanionRelay reconnects after an outbound transport closes", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
  });
  const transports = [new MemoryRelayTransport(), new MemoryRelayTransport()];
  let connections = 0;
  const outbound = new OutboundCompanionRelay({
    bridge,
    connectTransport: async () => {
      const transport = transports[connections];
      connections += 1;
      if (transport === undefined) {
        throw new Error("No more test transports");
      }
      return transport;
    },
    minReconnectMs: 1,
    maxReconnectMs: 2,
  });

  outbound.start();
  await flush();
  assert.equal(connections, 1);
  transports[0]?.disconnect();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await flush();
  assert.equal(connections, 2);
  assert.equal(transports[1]?.sent[0]?.type, "device.connect");
  outbound.stop();
});
