import assert from "node:assert/strict";
import { test } from "node:test";
import { RollRpcError } from "@roll-agent/client-node";
import {
  RUNTIME_METHODS,
  RUNTIME_SERVER_REQUEST_METHODS,
  parseRuntimeMethodParams,
  parseRuntimeMethodResult,
  parseRuntimeServerRequestParams,
  runtimeEventEnvelopeSchema,
  runtimeEventEnvelopeV11Schema,
  type ApprovalRequestParams,
  type InitializeResult,
  type JsonValue,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodInput,
  type RuntimeMethodResult,
} from "@roll-agent/protocol";
import {
  CompanionApprovalRequestBroker,
  CompanionWorkspace,
  LocalApprovalDeniedError,
  LocalConfirmationRequiredError,
  type CompanionRuntimeClient,
  type LocalApprovalDecision,
  type LocalApprovalPolicy,
} from "./companion-workspace.ts";
import { CompanionEventBuffer } from "./event-buffer.ts";
import {
  CompanionRelayBridge,
  OutboundCompanionRelay,
  relayEventMessage,
  type RelayPayloadCipher,
  type RelayTransport,
} from "./relay-bridge.ts";
import { WorkspaceLeaseManager } from "./lease-manager.ts";
import {
  COMPANION_RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_METHODS,
  deviceIdSchema,
  relayDeviceConnectSchema,
  relayMessageSchema,
  relayRequestMethodSchemas,
  relayRuntimeRequestSchema,
  relayRuntimeResponseSchema,
  workspaceIdSchema,
  type RelayEncryptedMessage,
  type RelayMessage,
  type RelayRuntimeRequest,
} from "@roll-agent/relay-protocol";
import {
  runRelayProtocolConformance,
  runtimeRelayProtocolConformanceAdapter,
} from "@roll-agent/relay-protocol/conformance";
import {
  relayMessageSchema as legacyRelayMessageSchema,
  type RelayEncryptedMessage as LegacyRelayEncryptedMessage,
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
  serverApprovalRequest: "00000000-0000-4000-8000-000000000418",
} as const;

function envelope(sequence: number, event: unknown): RuntimeEventEnvelope {
  return runtimeEventEnvelopeSchema.parse({
    protocolVersion: "1.0",
    runtimeInstanceId: IDS.runtime,
    sequence,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event,
  });
}

function v11Envelope(sequence: number, event: unknown): RuntimeEventEnvelope {
  return runtimeEventEnvelopeSchema.parse({
    protocolVersion: "1.1",
    runtimeInstanceId: IDS.runtime,
    sequence,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event,
  });
}

function v12Envelope(sequence: number, event: unknown): RuntimeEventEnvelope {
  return runtimeEventEnvelopeSchema.parse({
    protocolVersion: "1.2",
    runtimeInstanceId: IDS.runtime,
    sequence,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event,
  });
}

function approvalRequestParams(): ApprovalRequestParams {
  return parseRuntimeServerRequestParams(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, {
    threadId: IDS.thread,
    approval: {
      id: IDS.approval,
      turnId: IDS.turn,
      agentName: "demo-agent",
      toolName: "dangerous-write",
      preview: { path: "/tmp/demo" },
    },
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

class FakeV11RuntimeClient extends FakeRuntimeClient {
  getInitializationResult(): Pick<InitializeResult, "protocolVersion"> {
    return { protocolVersion: "1.1" };
  }
}

class FailingSubscriptionRuntimeClient extends FakeV11RuntimeClient {
  failSubscription = true;

  override onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void {
    if (this.failSubscription) {
      throw new Error("subscription failed");
    }
    return super.onEvent(listener);
  }
}

class InvalidRelayResultWorkspace extends CompanionWorkspace {
  override async handleRemoteRequest(_request: RelayRuntimeRequest): Promise<unknown> {
    return undefined;
  }
}

class LatestSnapshotWorkspace extends CompanionWorkspace {
  override async handleRemoteRequest(request: RelayRuntimeRequest): Promise<unknown> {
    if (
      request.method !== RUNTIME_METHODS.threadOpen &&
      request.method !== RUNTIME_METHODS.threadSnapshot
    ) {
      throw new Error(`Unexpected latest Snapshot request: ${request.method}`);
    }
    return {
      thread: {
        id: IDS.thread,
        title: "Runtime 1.2 snapshot",
        model: "fixture-model",
        createdAt: "2026-07-28T12:00:00.000Z",
        updatedAt: "2026-07-28T12:01:00.000Z",
        messageCount: 0,
      },
      messages: { items: [], nextBeforeSequence: null },
      operations: { items: [], nextBeforeSequence: null },
      activeTurn: {
        id: IDS.turn,
        status: "waiting-for-user",
        startedAt: "2026-07-28T12:00:00.000Z",
      },
      pendingApprovals: [],
      pendingInteractions: [
        {
          method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
          interactionId: IDS.serverApprovalRequest,
          threadId: IDS.thread,
          turnId: IDS.turn,
          expiresAt: "2026-07-28T12:05:00.000Z",
          sensitivity: "normal",
          approvalId: IDS.approval,
        },
      ],
      transcriptCompleteness: "complete",
    };
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

class RejectingDuplicateTurnRuntimeClient extends FakeRuntimeClient {
  private releaseFirstRequest: (() => void) | undefined;
  private readonly firstRequest = new Promise<void>((resolve) => {
    this.releaseFirstRequest = resolve;
  });
  private turnStartCalls = 0;

  override async request<TMethod extends RuntimeMethod>(
    method: TMethod,
    input: RuntimeMethodInput<TMethod>,
  ): Promise<RuntimeMethodResult<TMethod>> {
    if (method !== RUNTIME_METHODS.turnStart) {
      return super.request(method, input);
    }
    this.requests.push({ method, input });
    const params = parseRuntimeMethodParams(RUNTIME_METHODS.turnStart, input);
    this.turnStartCalls += 1;
    if (this.turnStartCalls > 1) {
      throw new Error("duplicate turn rejected");
    }
    await this.firstRequest;
    return parseRuntimeMethodResult(method, {
      accepted: true,
      turnId: params.turnId,
    });
  }

  release(): void {
    this.releaseFirstRequest?.();
    this.releaseFirstRequest = undefined;
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

class RejectingRelayTransport extends MemoryRelayTransport {
  readonly attempted: RelayMessage[] = [];
  closed = false;
  private readonly shouldReject: (message: RelayMessage) => boolean;

  constructor(shouldReject: (message: RelayMessage) => boolean) {
    super();
    this.shouldReject = shouldReject;
  }

  override async send(message: RelayMessage): Promise<void> {
    const parsed = relayMessageSchema.parse(message);
    this.attempted.push(parsed);
    if (this.shouldReject(parsed)) {
      throw new Error(`Rejected Relay frame: ${parsed.type}`);
    }
    super.send(parsed);
  }

  override close(): void {
    this.closed = true;
    super.close();
  }
}

class DeferredEventRelayTransport extends MemoryRelayTransport {
  private rejectEventSend: ((reason: Error) => void) | undefined;

  override send(message: RelayMessage): void | Promise<void> {
    super.send(message);
    if (message.type !== "runtime.event") {
      return;
    }
    return new Promise<void>((_resolve, reject) => {
      this.rejectEventSend = reject;
    });
  }

  rejectPendingEvent(): void {
    this.rejectEventSend?.(new Error("Deferred Relay event rejection"));
    this.rejectEventSend = undefined;
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

test("WorkspaceLeaseManager stale release cannot remove a replacement lease", () => {
  const leases = new WorkspaceLeaseManager();
  const releaseFirst = leases.acquire({ kind: "client", id: "browser-1" });
  const releaseReplacement = leases.acquire({ kind: "client", id: "browser-1" });

  releaseFirst();
  assert.equal(leases.has({ kind: "client", id: "browser-1" }), true);
  assert.equal(leases.canStopRuntime(), false);
  assert.deepEqual(leases.list(), [{ kind: "client", id: "browser-1" }]);

  releaseReplacement();
  assert.equal(leases.canStopRuntime(), true);
});

test("WorkspaceLeaseManager restores an older live lease after its replacement releases", () => {
  const leases = new WorkspaceLeaseManager();
  const releaseFirst = leases.acquire({ kind: "client", id: "browser-1" });
  const releaseReplacement = leases.acquire({ kind: "client", id: "browser-1" });

  releaseReplacement();
  assert.equal(leases.has({ kind: "client", id: "browser-1" }), true);
  assert.equal(leases.canStopRuntime(), false);

  releaseFirst();
  assert.equal(leases.canStopRuntime(), true);
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

test("a rejected duplicate turn.start cannot release the original Turn lease", async () => {
  const client = new RejectingDuplicateTurnRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const firstStart = workspace.startTurn({
    requestId: IDS.requestStart,
    threadId: IDS.thread,
    turnId: IDS.turn,
    input: { text: "first request remains active" },
  });
  assert.equal(workspace.leases.has({ kind: "turn", id: IDS.turn }), true);

  await assert.rejects(
    workspace.startTurn({
      requestId: IDS.secondRequestStart,
      threadId: IDS.thread,
      turnId: IDS.turn,
      input: { text: "duplicate request" },
    }),
    /duplicate turn rejected/u,
  );
  assert.equal(workspace.leases.has({ kind: "turn", id: IDS.turn }), true);
  assert.equal(workspace.leases.canStopRuntime(), false);
  assert.equal(
    client.requests.filter((request) => request.method === RUNTIME_METHODS.turnStart).length,
    2,
  );

  client.release();
  await firstStart;
  client.emit(envelope(0, { type: "turn.completed" }));
  assert.equal(workspace.leases.has({ kind: "turn", id: IDS.turn }), false);
});

test("Protocol 1.0 rejects invalid local policy decisions without authorizing Runtime", async () => {
  const client = new FakeRuntimeClient();
  const invalidPolicy = (() => undefined) as unknown as LocalApprovalPolicy;
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: invalidPolicy,
  });
  client.emit(
    envelope(0, {
      type: "approval.required",
      approval: approvalRequestParams().approval,
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
    /invalid approval decision/u,
  );
  assert.equal(
    client.requests.some((request) => request.method === RUNTIME_METHODS.approvalRespond),
    false,
  );
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), true);

  client.emit(envelope(1, { type: "turn.cancelled", reason: "cancelled", message: "cancelled" }));
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);
});

test("Protocol 1.0 aborts an in-flight local policy when its Turn terminates", async () => {
  const client = new FakeRuntimeClient();
  let notifyPolicyStarted: () => void = () => {};
  const policyStarted = new Promise<void>((resolve) => {
    notifyPolicyStarted = resolve;
  });
  let policySignal: AbortSignal | undefined;
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: async (_approval, { signal }) => {
      policySignal = signal;
      notifyPolicyStarted();
      return new Promise<LocalApprovalDecision>(() => {});
    },
  });
  client.emit(
    envelope(0, {
      type: "approval.required",
      approval: approvalRequestParams().approval,
    }),
  );
  const candidate = workspace.respondApproval({
    requestId: IDS.requestApproval,
    threadId: IDS.thread,
    turnId: IDS.turn,
    approvalId: IDS.approval,
    decision: "approve",
  });

  await policyStarted;
  client.emit(envelope(1, { type: "turn.cancelled", reason: "cancelled", message: "cancelled" }));

  await assert.rejects(candidate, /Turn ended with turn\.cancelled/u);
  assert.equal(policySignal?.aborted, true);
  assert.equal(
    client.requests.some((request) => request.method === RUNTIME_METHODS.approvalRespond),
    false,
  );
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);
});

test("Protocol 1.0 reject supersedes and aborts an in-flight approve policy", async () => {
  const client = new FakeRuntimeClient();
  let notifyPolicyStarted: () => void = () => {};
  const policyStarted = new Promise<void>((resolve) => {
    notifyPolicyStarted = resolve;
  });
  let policySignal: AbortSignal | undefined;
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: async (_approval, { signal }) => {
      policySignal = signal;
      notifyPolicyStarted();
      return new Promise<LocalApprovalDecision>(() => {});
    },
  });
  client.emit(
    envelope(0, {
      type: "approval.required",
      approval: approvalRequestParams().approval,
    }),
  );
  const approveOutcome = assert.rejects(
    workspace.respondApproval({
      requestId: IDS.requestApproval,
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    /resolved by another response/u,
  );

  await policyStarted;
  assert.deepEqual(
    await workspace.respondApproval({
      requestId: "00000000-0000-4000-8000-000000000419",
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "reject",
      reason: "User revoked approval",
    }),
    { resolved: true },
  );

  await approveOutcome;
  assert.equal(policySignal?.aborted, true);
  assert.equal(
    client.requests.filter((request) => request.method === RUNTIME_METHODS.approvalRespond).length,
    1,
  );
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);
});

test("CompanionWorkspace requires the registered approval broker for Protocol 1.1", () => {
  assert.throws(
    () =>
      new CompanionWorkspace({
        client: new FakeV11RuntimeClient(),
        localApprovalPolicy: () => "allow",
      }),
    /requires a CompanionApprovalRequestBroker/u,
  );
});

test("Companion approval policy bindings are same-instance, rollback-safe, and released on close", async () => {
  const broker = new CompanionApprovalRequestBroker();
  const firstPolicy: LocalApprovalPolicy = () => "allow";
  const secondPolicy: LocalApprovalPolicy = () => "deny";
  const releaseFirst = broker.bindLocalApprovalPolicy(firstPolicy);
  assert.throws(
    () => broker.bindLocalApprovalPolicy(secondPolicy),
    /already bound to a workspace/u,
  );
  releaseFirst();
  const releaseSecond = broker.bindLocalApprovalPolicy(secondPolicy);
  releaseFirst();
  assert.throws(() => broker.bindLocalApprovalPolicy(firstPolicy), /already bound to a workspace/u);
  releaseSecond();

  assert.throws(
    () =>
      new CompanionWorkspace({
        client: new FakeV11RuntimeClient(),
        approvalRequestBroker: broker,
        localApprovalPolicy: firstPolicy,
        maxEvents: 0,
      }),
    /maxEvents must be a positive integer/u,
  );

  const client = new FailingSubscriptionRuntimeClient();
  assert.throws(
    () =>
      new CompanionWorkspace({
        client,
        approvalRequestBroker: broker,
        localApprovalPolicy: firstPolicy,
      }),
    /subscription failed/u,
  );
  client.failSubscription = false;
  const workspace = new CompanionWorkspace({
    client,
    approvalRequestBroker: broker,
    localApprovalPolicy: firstPolicy,
  });
  assert.equal(await workspace.closeIfIdle(), true);

  const replacement = new CompanionWorkspace({
    client,
    approvalRequestBroker: broker,
    localApprovalPolicy: secondPolicy,
  });
  assert.equal(await replacement.closeIfIdle(), true);
});

test("Protocol 1.1 applies deny-wins while an approval candidate is under local review", async () => {
  const broker = new CompanionApprovalRequestBroker();
  const client = new FakeV11RuntimeClient();
  let notifyPolicyStarted: () => void = () => {};
  const policyStarted = new Promise<void>((resolve) => {
    notifyPolicyStarted = resolve;
  });
  let policySignal: AbortSignal | undefined;
  const workspace = new CompanionWorkspace({
    client,
    approvalRequestBroker: broker,
    localApprovalPolicy: async (_approval, { signal }) => {
      policySignal = signal;
      notifyPolicyStarted();
      return new Promise<LocalApprovalDecision>(() => {});
    },
  });
  const runtimeDecision = Promise.resolve(
    broker.handle(approvalRequestParams(), {
      requestId: IDS.serverApprovalRequest,
      signal: new AbortController().signal,
    }),
  );
  const approveOutcome = assert.rejects(
    workspace.submitApprovalCandidate({
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    /superseded by rejection/u,
  );

  await policyStarted;
  await assert.rejects(
    workspace.submitApprovalCandidate({
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    /already has an approval candidate in progress/u,
  );
  assert.deepEqual(
    await workspace.submitApprovalCandidate({
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "reject",
      reason: "User revoked approval",
    }),
    { accepted: true },
  );

  await approveOutcome;
  assert.equal(policySignal?.aborted, true);
  assert.deepEqual(await runtimeDecision, {
    decision: "reject",
    reason: "User revoked approval",
  });
  await assert.rejects(
    workspace.submitApprovalCandidate({
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    /is no longer pending/u,
  );
});

test("Protocol 1.1 routes Relay approval candidates through the local broker policy", async () => {
  const broker = new CompanionApprovalRequestBroker();
  const client = new FakeV11RuntimeClient();
  let policyCalls = 0;
  const workspace = new CompanionWorkspace({
    client,
    approvalRequestBroker: broker,
    localApprovalPolicy: () => {
      policyCalls += 1;
      return "allow";
    },
  });

  client.emit(
    v11Envelope(0, {
      type: "approval.required",
      approval: approvalRequestParams().approval,
    }),
  );
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);

  const controller = new AbortController();
  const runtimeDecision = Promise.resolve(
    broker.handle(approvalRequestParams(), {
      requestId: IDS.serverApprovalRequest,
      signal: controller.signal,
    }),
  );
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), true);
  await assert.rejects(
    workspace.respondApproval({
      requestId: IDS.requestApproval,
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    /must use the Relay approval\.candidate method/u,
  );

  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
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
    method: RELAY_REQUEST_METHODS.approvalCandidate,
    params: {
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    },
  });
  await flush();

  assert.deepEqual(await runtimeDecision, { decision: "approve" });
  assert.equal(policyCalls, 1);
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);
  assert.equal(
    client.requests.filter((request) => request.method === RUNTIME_METHODS.approvalRespond).length,
    0,
  );
  assert.deepEqual(
    transport.sent.find(
      (message) => message.type === "runtime.response" && message.requestId === IDS.relayRequest,
    ),
    {
      type: "runtime.response",
      requestId: IDS.relayRequest,
      workspaceId,
      result: { accepted: true },
    },
  );
  assert.equal(
    workspace.replay(-1).events.some((entry) => entry.event.event.type === "approval.resolved"),
    false,
  );
  client.emit(
    v11Envelope(1, {
      type: "approval.resolved",
      approvalId: IDS.approval,
      resolution: { status: "resolved", decision: "approve" },
    }),
  );
  assert.deepEqual(workspace.replay(-1).events.at(-1)?.event.event, {
    type: "approval.resolved",
    approvalId: IDS.approval,
    resolution: { status: "resolved", decision: "approve" },
  });
  bridge.close();
});

test("Protocol 1.1 redacts local policy failures from Relay responses", async () => {
  const policyFailures = [
    new Error("secret-plain-error=abc123"),
    new LocalApprovalDeniedError("secret-denied-error=abc123"),
    new LocalConfirmationRequiredError("secret-confirmation-error=abc123"),
  ];

  for (const policyFailure of policyFailures) {
    const broker = new CompanionApprovalRequestBroker();
    const client = new FakeV11RuntimeClient();
    const workspace = new CompanionWorkspace({
      client,
      approvalRequestBroker: broker,
      localApprovalPolicy: () => {
        throw policyFailure;
      },
    });
    const runtimeOutcome = Promise.resolve(
      broker.handle(approvalRequestParams(), {
        requestId: IDS.serverApprovalRequest,
        signal: new AbortController().signal,
      }),
    ).then(
      (result) => result,
      (error: unknown) => error,
    );

    const workspaceId = workspaceIdSchema.parse(IDS.workspace);
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
      method: RELAY_REQUEST_METHODS.approvalCandidate,
      params: {
        threadId: IDS.thread,
        turnId: IDS.turn,
        approvalId: IDS.approval,
        decision: "approve",
      },
    });
    await flush();

    assert.ok((await runtimeOutcome) instanceof Error);
    const response = transport.sent.find(
      (message) => message.type === "runtime.response" && message.requestId === IDS.relayRequest,
    );
    assert.equal(JSON.stringify(response).includes(policyFailure.message), false);
    assert.deepEqual(response?.type === "runtime.response" ? response.error : undefined, {
      code: "COMPANION_ERROR",
      message: "Companion request failed",
      retryable: false,
    });
    assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);
    bridge.close();
  }
});

test("Protocol 1.1 rejects invalid local policy decisions without approving Runtime", async () => {
  const broker = new CompanionApprovalRequestBroker();
  const client = new FakeV11RuntimeClient();
  const invalidPolicy = (() => undefined) as unknown as LocalApprovalPolicy;
  const workspace = new CompanionWorkspace({
    client,
    approvalRequestBroker: broker,
    localApprovalPolicy: invalidPolicy,
  });
  const controller = new AbortController();
  const runtimeDecision = Promise.resolve(
    broker.handle(approvalRequestParams(), {
      requestId: IDS.serverApprovalRequest,
      signal: controller.signal,
    }),
  );

  await assert.rejects(
    workspace.submitApprovalCandidate({
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    /invalid approval decision/u,
  );
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);
  assert.equal(
    client.requests.some((request) => request.method === RUNTIME_METHODS.approvalRespond),
    false,
  );
  await assert.rejects(runtimeDecision, /invalid approval decision/u);
});

test("Protocol 1.1 keeps a candidate pending for local confirmation and fails closed on deny", async () => {
  const broker = new CompanionApprovalRequestBroker();
  const client = new FakeV11RuntimeClient();
  let decision: LocalApprovalDecision = "require-local-confirmation";
  const workspace = new CompanionWorkspace({
    client,
    approvalRequestBroker: broker,
    localApprovalPolicy: () => decision,
  });
  const controller = new AbortController();
  const runtimeDecision = Promise.resolve(
    broker.handle(approvalRequestParams(), {
      requestId: IDS.serverApprovalRequest,
      signal: controller.signal,
    }),
  );

  await assert.rejects(
    workspace.submitApprovalCandidate({
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    LocalConfirmationRequiredError,
  );
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), true);

  decision = "deny";
  await assert.rejects(
    workspace.submitApprovalCandidate({
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    LocalApprovalDeniedError,
  );
  assert.deepEqual(await runtimeDecision, {
    decision: "reject",
    reason: "Local Companion policy denied remote approval",
  });
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);
  assert.equal(
    client.requests.filter((request) => request.method === RUNTIME_METHODS.approvalRespond).length,
    0,
  );
});

test("Protocol 1.1 releases its approval lease when Runtime cancels the request", async () => {
  const broker = new CompanionApprovalRequestBroker();
  const client = new FakeV11RuntimeClient();
  let notifyPolicyStarted: () => void = () => {};
  const policyStarted = new Promise<void>((resolve) => {
    notifyPolicyStarted = resolve;
  });
  let policySignal: AbortSignal | undefined;
  const workspace = new CompanionWorkspace({
    client,
    approvalRequestBroker: broker,
    localApprovalPolicy: async (_approval, { signal }) => {
      policySignal = signal;
      notifyPolicyStarted();
      return new Promise<LocalApprovalDecision>(() => {});
    },
  });
  const controller = new AbortController();
  const runtimeDecision = Promise.resolve(
    broker.handle(approvalRequestParams(), {
      requestId: IDS.serverApprovalRequest,
      signal: controller.signal,
    }),
  );
  const candidateDecision = workspace.submitApprovalCandidate({
    threadId: IDS.thread,
    turnId: IDS.turn,
    approvalId: IDS.approval,
    decision: "approve",
  });

  await policyStarted;
  controller.abort(new Error("turn cancelled"));
  await assert.rejects(runtimeDecision, /turn cancelled/u);
  await assert.rejects(candidateDecision, /turn cancelled/u);
  assert.equal(policySignal?.aborted, true);
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);
  await assert.rejects(
    workspace.submitApprovalCandidate({
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }),
    /is no longer pending/u,
  );
});

test("Protocol 1.1 accepts a remote rejection without invoking approval policy", async () => {
  const broker = new CompanionApprovalRequestBroker();
  const client = new FakeV11RuntimeClient();
  let policyCalls = 0;
  const workspace = new CompanionWorkspace({
    client,
    approvalRequestBroker: broker,
    localApprovalPolicy: () => {
      policyCalls += 1;
      return "deny";
    },
  });
  const controller = new AbortController();
  const runtimeDecision = Promise.resolve(
    broker.handle(approvalRequestParams(), {
      requestId: IDS.serverApprovalRequest,
      signal: controller.signal,
    }),
  );

  assert.deepEqual(
    await workspace.submitApprovalCandidate({
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "reject",
      reason: "User cancelled",
    }),
    { accepted: true },
  );
  assert.deepEqual(await runtimeDecision, {
    decision: "reject",
    reason: "User cancelled",
  });
  assert.equal(policyCalls, 0);
  assert.equal(workspace.leases.has({ kind: "approval", id: IDS.approval }), false);
});

test("Companion Relay Protocol remains separate from Runtime Protocol", () => {
  assert.equal(legacyRelayMessageSchema, relayMessageSchema);
  assert.equal(COMPANION_RELAY_PROTOCOL_VERSION, "1.0");
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
  const plainEnvelopeId: string = IDS.relayRequest;
  const legacyEncryptedMessage: LegacyRelayEncryptedMessage = {
    type: "runtime.encrypted",
    workspaceId: workspaceIdSchema.parse(IDS.workspace),
    envelopeId: plainEnvelopeId,
    payloadKind: "event",
    relaySequence: 0,
    algorithm: "example-aead",
    nonce: "opaque-nonce",
    ciphertext: "opaque-ciphertext",
  };
  assert.deepEqual(legacyRelayMessageSchema.parse(legacyEncryptedMessage), legacyEncryptedMessage);
});

test("Companion consumes the shared Relay Protocol conformance suite", () => {
  assert.deepEqual(runRelayProtocolConformance(runtimeRelayProtocolConformanceAdapter), {
    protocolVersion: "1.0",
    passed: true,
    failures: [],
  });
});

test("Relay 1.0 projects Runtime 1.2 events to its frozen Runtime 1.1 envelope", async () => {
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
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

  const runtimeEvent = v12Envelope(0, { type: "turn.completed" });
  client.emit(runtimeEvent);
  await flush();
  const relayed = transport.sent.find((message) => message.type === "runtime.event");
  assert.ok(relayed?.type === "runtime.event");
  assert.equal(relayed.event.protocolVersion, "1.1");
  assert.deepEqual(relayMessageSchema.parse(relayed), relayed);

  const projected = relayEventMessage(workspaceId, 1, runtimeEvent);
  assert.ok(projected.type === "runtime.event");
  assert.equal(projected.event.protocolVersion, "1.1");
  bridge.close();

  const encryptedClient = new FakeRuntimeClient();
  const encryptedWorkspace = new CompanionWorkspace({
    client: encryptedClient,
    localApprovalPolicy: () => "allow",
  });
  const encryptedBridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, encryptedWorkspace]]),
    ciphers: new Map([[workspaceId, testCipher]]),
  });
  const encryptedTransport = new MemoryRelayTransport();
  encryptedBridge.connect(encryptedTransport);
  await flush();
  encryptedClient.emit(runtimeEvent);
  await flush();
  const encrypted = encryptedTransport.sent.find(
    (message) => message.type === "runtime.encrypted" && message.payloadKind === "event",
  );
  assert.ok(encrypted?.type === "runtime.encrypted" && encrypted.payloadKind === "event");
  assert.equal(
    runtimeEventEnvelopeV11Schema.parse(await testCipher.decrypt(encrypted)).protocolVersion,
    "1.1",
  );
  encryptedBridge.close();
});

test("Relay 1.0 projects Runtime 1.2 thread results to the frozen Snapshot shape", async () => {
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const workspace = new LatestSnapshotWorkspace({
    client: new FakeRuntimeClient(),
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

  for (const [requestId, method, params] of [
    [
      IDS.relaySnapshotRequest,
      RUNTIME_METHODS.threadSnapshot,
      { threadId: IDS.thread, limit: 100 },
    ],
    [IDS.relaySecondRequest, RUNTIME_METHODS.threadOpen, { threadId: IDS.thread }],
  ] as const) {
    transport.receive({
      type: "runtime.request",
      requestId,
      workspaceId,
      method,
      params,
    });
    await flush();
    const response = transport.sent.find(
      (message) => message.type === "runtime.response" && message.requestId === requestId,
    );
    assert.ok(response?.type === "runtime.response");
    assert.equal(response.error, undefined);
    const snapshot = relayRequestMethodSchemas[method].result.parse(response.result);
    assert.equal(Object.hasOwn(snapshot, "pendingInteractions"), false);
    assert.equal(snapshot.activeTurn?.status, "running");
  }

  bridge.close();
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
  assert.equal(
    first.sent[0]?.type === "device.connect" ? first.sent[0].protocolVersion : undefined,
    "1.0",
  );

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

test("CompanionRelayBridge faults a generation on an event send failure and replays the full prefix", async () => {
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
  const first = new RejectingRelayTransport(
    (message) => message.type === "runtime.event" && message.relaySequence === 0,
  );
  bridge.connect(first);
  await flush();

  client.emit(envelope(0, { type: "turn.completed" }));
  client.emit(envelope(1, { type: "capabilities.changed" }));
  await flush();
  assert.equal(first.closed, true);
  assert.deepEqual(
    first.attempted
      .filter((message) => message.type === "runtime.event")
      .map((message) => message.relaySequence),
    [0],
  );
  assert.deepEqual(
    first.sent
      .filter((message) => message.type === "runtime.event")
      .map((message) => message.relaySequence),
    [],
  );

  first.receive({
    type: "runtime.ack",
    workspaceId,
    throughRelaySequence: 1,
  });
  const second = new MemoryRelayTransport();
  bridge.connect(second);
  await flush();
  assert.deepEqual(
    second.sent
      .filter((message) => message.type === "runtime.event")
      .map((message) => message.relaySequence),
    [0, 1],
  );

  second.receive({
    type: "runtime.ack",
    workspaceId,
    throughRelaySequence: 1,
  });
  await flush();
  second.disconnect();
  const third = new MemoryRelayTransport();
  bridge.connect(third);
  await flush();
  assert.deepEqual(
    third.sent
      .filter((message) => message.type === "runtime.event")
      .map((message) => message.relaySequence),
    [],
  );
  bridge.close();
});

test("CompanionRelayBridge stops a generation when device.connect fails", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  client.emit(envelope(0, { type: "capabilities.changed" }));
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
  });
  const first = new RejectingRelayTransport((message) => message.type === "device.connect");
  bridge.connect(first);
  await flush();
  assert.equal(first.closed, true);
  assert.deepEqual(
    first.attempted.map((message) => message.type),
    ["device.connect"],
  );

  const second = new MemoryRelayTransport();
  bridge.connect(second);
  await flush();
  assert.deepEqual(
    second.sent.map((message) => message.type),
    ["device.connect", "runtime.event"],
  );
  bridge.close();
});

test("CompanionRelayBridge retries a failed gap before sending retained events", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
    maxEvents: 1,
  });
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  client.emit(envelope(0, { type: "turn.completed" }));
  client.emit(envelope(1, { type: "capabilities.changed" }));
  const bridge = new CompanionRelayBridge({
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "pairing-token-with-sufficient-length",
    workspaces: new Map([[workspaceId, workspace]]),
  });
  const first = new RejectingRelayTransport((message) => message.type === "runtime.gap");
  bridge.connect(first);
  await flush();
  assert.equal(first.closed, true);
  assert.deepEqual(
    first.attempted.map((message) => message.type),
    ["device.connect", "runtime.gap"],
  );

  const second = new MemoryRelayTransport();
  bridge.connect(second);
  await flush();
  assert.deepEqual(
    second.sent.map((message) => message.type),
    ["device.connect", "runtime.gap", "runtime.event"],
  );
  bridge.close();
});

test("CompanionRelayBridge retries encrypted events after a send failure", async () => {
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
  const first = new RejectingRelayTransport(
    (message) =>
      message.type === "runtime.encrypted" &&
      message.payloadKind === "event" &&
      message.relaySequence === 0,
  );
  bridge.connect(first);
  await flush();
  client.emit(envelope(0, { type: "capabilities.changed" }));
  await flush();
  assert.equal(first.closed, true);

  const second = new MemoryRelayTransport();
  bridge.connect(second);
  await flush();
  assert.deepEqual(
    second.sent.flatMap((message) =>
      message.type === "runtime.encrypted" && message.payloadKind === "event"
        ? [message.relaySequence]
        : [],
    ),
    [0],
  );
  bridge.close();
});

test("CompanionRelayBridge retries a cached mutation response without reinvoking Runtime", async () => {
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
  const request = turnRelayRequest(
    IDS.relayRequest,
    IDS.requestStart,
    IDS.turn,
    "retry cached response",
  );
  const first = new RejectingRelayTransport(
    (message) => message.type === "runtime.response" && message.requestId === IDS.relayRequest,
  );
  bridge.connect(first);
  await flush();
  first.receive(request);
  await flush();

  assert.equal(first.closed, true);
  assert.equal(
    client.requests.filter((entry) => entry.method === RUNTIME_METHODS.turnStart).length,
    1,
  );

  const second = new MemoryRelayTransport();
  bridge.connect(second);
  await flush();
  second.receive(request);
  await flush();

  assert.equal(
    client.requests.filter((entry) => entry.method === RUNTIME_METHODS.turnStart).length,
    1,
  );
  assert.deepEqual(
    second.sent.find(
      (message) => message.type === "runtime.response" && message.requestId === IDS.relayRequest,
    ),
    {
      type: "runtime.response",
      requestId: IDS.relayRequest,
      workspaceId,
      result: { accepted: true, turnId: IDS.turn },
    },
  );
  bridge.close();
});

test("a late rejection from an old Relay generation cannot close the current transport", async () => {
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
  const first = new DeferredEventRelayTransport();
  bridge.connect(first);
  await flush();
  client.emit(envelope(0, { type: "turn.completed" }));
  await flush();

  const second = new MemoryRelayTransport();
  bridge.connect(second);
  await flush();
  first.rejectPendingEvent();
  await flush();
  client.emit(envelope(1, { type: "capabilities.changed" }));
  await flush();
  assert.deepEqual(
    second.sent
      .filter((message) => message.type === "runtime.event")
      .map((message) => message.relaySequence),
    [0, 1],
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

test("CompanionRelayBridge rejects plaintext requests for cipher workspaces", async () => {
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

  const sensitiveText = "plaintext must never reach Runtime";
  transport.receive(turnRelayRequest(IDS.relayRequest, IDS.requestStart, IDS.turn, sensitiveText));
  await flush();

  assert.equal(client.requests.length, 0);
  assert.equal(workspace.leases.canStopRuntime(), true);
  assert.equal(
    transport.sent.some((message) => message.type === "runtime.response"),
    false,
  );
  const encryptedResponse = transport.sent.find(
    (message): message is RelayEncryptedMessage =>
      message.type === "runtime.encrypted" &&
      message.payloadKind === "response" &&
      message.requestId === IDS.relayRequest,
  );
  assert.ok(encryptedResponse !== undefined);
  assert.deepEqual(
    relayRuntimeResponseSchema.parse(await testCipher.decrypt(encryptedResponse)).error,
    {
      code: "RELAY_ENCRYPTION_REQUIRED",
      message: "Encrypted Relay request required for this workspace",
      retryable: false,
    },
  );
  assert.equal(JSON.stringify(transport.sent).includes(sensitiveText), false);
  bridge.close();
});

test("CompanionWorkspace isolates buffered-event listeners so Relay delivery continues", async () => {
  const client = new FakeRuntimeClient();
  const workspace = new CompanionWorkspace({
    client,
    localApprovalPolicy: () => "allow",
  });
  const releaseThrowingListener = workspace.onBufferedEvent(() => {
    throw new Error("subscriber exploded");
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

  assert.doesNotThrow(() => {
    client.emit(envelope(0, { type: "turn.completed" }));
  });
  await flush();
  assert.equal(workspace.replay(-1).events.length, 1);
  assert.equal(
    transport.sent.some(
      (message) =>
        message.type === "runtime.event" && message.event.event.type === "turn.completed",
    ),
    true,
  );

  releaseThrowingListener();
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
      input: { text: largeInput },
      turnId: IDS.turn,
      threadId: IDS.thread,
      requestId: IDS.requestStart,
    },
  });
  await flush();
  assert.equal(
    client.requests.filter((entry) => entry.method === RUNTIME_METHODS.turnStart).length,
    1,
  );
  assert.equal(
    transport.sent.filter(
      (message) => message.type === "runtime.response" && message.requestId === IDS.relayRequest,
    ).length,
    3,
  );

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

test("CompanionRelayBridge reports only method-param validation as INVALID_PARAMS", async () => {
  const broker = new CompanionApprovalRequestBroker();
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const workspace = new CompanionWorkspace({
    client: new FakeV11RuntimeClient(),
    approvalRequestBroker: broker,
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
    method: RUNTIME_METHODS.turnStart,
    params: {
      requestId: IDS.requestStart,
      threadId: "not-a-thread-id",
      turnId: IDS.turn,
      input: { text: "invalid" },
    },
  });
  transport.receive({
    type: "runtime.request",
    requestId: IDS.relaySecondRequest,
    workspaceId,
    method: RELAY_REQUEST_METHODS.approvalCandidate,
    params: {
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "reject",
      reason: "",
    },
  });
  await flush();

  for (const requestId of [IDS.relayRequest, IDS.relaySecondRequest]) {
    const response = transport.sent.find(
      (message) => message.type === "runtime.response" && message.requestId === requestId,
    );
    assert.deepEqual(response?.type === "runtime.response" ? response.error : undefined, {
      code: "INVALID_PARAMS",
      message: "Invalid Relay request params",
      retryable: false,
    });
  }
  bridge.close();
});

test("CompanionRelayBridge keeps invalid internal results redacted as COMPANION_ERROR", async () => {
  const workspaceId = workspaceIdSchema.parse(IDS.workspace);
  const workspace = new InvalidRelayResultWorkspace({
    client: new FakeRuntimeClient(),
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
  assert.deepEqual(response?.type === "runtime.response" ? response.error : undefined, {
    code: "COMPANION_ERROR",
    message: "Companion request failed",
    retryable: false,
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

test("OutboundCompanionRelay reconnects and replays after an ordered send fails", async () => {
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
  const first = new RejectingRelayTransport(
    (message) => message.type === "runtime.event" && message.relaySequence === 0,
  );
  const second = new MemoryRelayTransport();
  const transports: RelayTransport[] = [first, second];
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
  client.emit(envelope(0, { type: "capabilities.changed" }));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await flush();
  assert.equal(first.closed, true);
  assert.equal(connections, 2);
  assert.deepEqual(
    second.sent
      .filter((message) => message.type === "runtime.event")
      .map((message) => message.relaySequence),
    [0],
  );
  outbound.stop();
});
