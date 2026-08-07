import assert from "node:assert/strict";
import test from "node:test";
import { RollRpcError } from "@roll-agent/client-node";
import {
  approvalIdSchema,
  jsonValueSchema,
  operationIdSchema,
  threadIdSchema,
  turnIdSchema,
  type JsonValue,
} from "@roll-agent/protocol";
import {
  RELAY_ERROR_CODES,
  RELAY_ERROR_CODES_V11,
  RELAY_INTERACTION_METHODS_V11,
  RELAY_REQUEST_METHODS_V11,
  deviceIdSchema,
  relayInteractionIdSchema,
  relayInteractionCandidateParamsSchemaV11,
  relayMessageSchemaV11,
  relayRequestIdSchema,
  relayRuntimeRequestSchemaV11,
  relayRuntimeResponseSchemaV11,
  workspaceIdSchema,
  type RelayEncryptedMessageV11,
  type RelayMessageV11,
  type RelayRuntimeRequestV11,
} from "@roll-agent/relay-protocol";
import type { RemoteInteractionCandidateContext } from "./interaction-broker.ts";
import {
  CompanionRelayBridgeV11,
  OutboundCompanionRelayV11,
  type CompanionWorkspaceV11Port,
  type RelayPayloadCipherV11,
  type RelayTransportV11,
} from "./relay-bridge-v11.ts";
import { LocalApprovalDeniedError, LocalConfirmationRequiredError } from "./companion-workspace.ts";
import {
  CompanionRelayFrameBuffer,
  type CompanionRelayFrameEntryV11,
} from "./relay-frame-buffer.ts";
import { InMemoryRelayTransportV11 } from "./testing.ts";
import {
  runRelayProtocolConformanceForVersion,
  runtimeRelayProtocolConformanceAdapterV11,
} from "@roll-agent/relay-protocol/conformance";

const IDS = {
  device: deviceIdSchema.parse("00000000-0000-4000-8000-000000000201"),
  workspace: workspaceIdSchema.parse("00000000-0000-4000-8000-000000000202"),
  thread: threadIdSchema.parse("00000000-0000-4000-8000-000000000203"),
  turn: turnIdSchema.parse("00000000-0000-4000-8000-000000000204"),
  interaction: relayInteractionIdSchema.parse("00000000-0000-4000-8000-000000000205"),
  approval: approvalIdSchema.parse("00000000-0000-4000-8000-000000000206"),
  request: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000207"),
  operation: operationIdSchema.parse("00000000-0000-4000-8000-000000000208"),
  snapshotRequest: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000209"),
  openRequest: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000210"),
  operationRequest: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000211"),
  runtimeErrorRequest: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000212"),
  deniedErrorRequest: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000213"),
  confirmationErrorRequest: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000214"),
  operationEnvelope: "00000000-0000-4000-8000-000000000215",
  runtimeErrorEnvelope: "00000000-0000-4000-8000-000000000216",
  deniedErrorEnvelope: "00000000-0000-4000-8000-000000000217",
  confirmationErrorEnvelope: "00000000-0000-4000-8000-000000000218",
} as const;

const SECRET_SENTINEL = "relay-secret-sentinel=abc123";

type WorkspaceRequestHandlerV11 = (
  request: RelayRuntimeRequestV11,
  context: RemoteInteractionCandidateContext,
) => unknown | Promise<unknown>;

type RelayRuntimeResponseMessageV11 = Extract<
  RelayMessageV11,
  { readonly type: "runtime.response" }
>;

class WorkspacePort implements CompanionWorkspaceV11Port {
  readonly frames = new CompanionRelayFrameBuffer();
  calls = 0;
  closeCalls = 0;
  private readonly listeners = new Set<(entry: CompanionRelayFrameEntryV11) => void>();
  private readonly requestHandler: WorkspaceRequestHandlerV11;

  constructor(requestHandler: WorkspaceRequestHandlerV11 = () => ({ accepted: true })) {
    this.requestHandler = requestHandler;
  }

  onBufferedRelayFrameV11(listener: (entry: CompanionRelayFrameEntryV11) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replayRelayFramesV11(afterRelaySequence = -1) {
    return this.frames.replay(afterRelaySequence);
  }

  acknowledgeRelayFramesV11(throughRelaySequence: number): void {
    this.frames.acknowledge(throughRelaySequence);
  }

  async handleRemoteRequestV11(
    request: RelayRuntimeRequestV11,
    context: RemoteInteractionCandidateContext,
  ): Promise<unknown> {
    this.calls += 1;
    return this.requestHandler(request, context);
  }

  closeRemoteInteractions(): void {
    this.closeCalls += 1;
  }

  appendInteraction(decision = "approve"): CompanionRelayFrameEntryV11 {
    const entry = this.frames.appendInteraction({
      type: "interaction.request",
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      expiresAt: "2099-08-04T12:00:00.000Z",
      sensitivity: "normal",
      method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
      projection: {
        approvalId: IDS.approval,
        agentName: "deploy-agent",
        toolName: `deploy-${decision}`,
      },
    });
    for (const listener of this.listeners) {
      listener(entry);
    }
    return entry;
  }
}

class MemoryRelayTransportV11 implements RelayTransportV11 {
  readonly sent: RelayMessageV11[] = [];
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();

  send(message: RelayMessageV11): void {
    this.sent.push(relayMessageSchemaV11.parse(message));
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    for (const listener of [...this.closeListeners]) {
      listener();
    }
  }

  receive(message: unknown): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }
}

class RecordingRelayPayloadCipherV11 implements RelayPayloadCipherV11 {
  readonly algorithm = "test-only-recording-cipher";
  readonly encryptedValues: JsonValue[] = [];
  private readonly requests = new Map<string, JsonValue>();

  queueRequest(request: RelayRuntimeRequestV11): void {
    this.requests.set(request.requestId, jsonValueSchema.parse(request));
  }

  async encrypt(value: JsonValue) {
    this.encryptedValues.push(value);
    return {
      nonce: `nonce-${String(this.encryptedValues.length)}`,
      ciphertext: `ciphertext-${String(this.encryptedValues.length)}`,
    };
  }

  async decrypt(message: RelayEncryptedMessageV11): Promise<JsonValue> {
    const requestId = message.requestId;
    if (requestId === undefined) {
      throw new Error("Encrypted test request is missing requestId");
    }
    const request = this.requests.get(requestId);
    if (request === undefined) {
      throw new Error(`No encrypted test request queued for ${requestId}`);
    }
    return request;
  }
}

function candidate(decision: "approve" | "reject" = "approve") {
  return relayInteractionCandidateParamsSchemaV11.parse({
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
    candidate: { decision },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function responses(messages: readonly RelayMessageV11[]) {
  return messages.filter((message) => message.type === "runtime.response");
}

function responseForV11(
  messages: readonly RelayMessageV11[],
  requestId: string,
): RelayRuntimeResponseMessageV11 {
  const response = messages.find(
    (message): message is RelayRuntimeResponseMessageV11 =>
      message.type === "runtime.response" && message.requestId === requestId,
  );
  assert.ok(response);
  return response;
}

function sensitiveOperation() {
  return {
    id: IDS.operation,
    sequence: 7,
    toolCallId: "tool-call-sensitive",
    agentName: "deploy-agent",
    toolName: "deploy",
    createdAt: "2026-08-04T12:00:00.000Z",
    outcome: { kind: "tool_failed", reason: SECRET_SENTINEL },
    display: { rawToolOutput: SECRET_SENTINEL },
  } as const;
}

function sensitiveSnapshot() {
  return {
    thread: {
      id: IDS.thread,
      title: "Sensitive projection fixture",
      model: "fixture-model",
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:01:00.000Z",
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [sensitiveOperation()], nextBeforeSequence: null },
    pendingApprovals: [
      {
        id: IDS.approval,
        turnId: IDS.turn,
        agentName: "deploy-agent",
        toolName: "deploy",
        preview: {
          command: SECRET_SENTINEL,
          explanation: "Approve the deployment",
        },
        reason: SECRET_SENTINEL,
      },
    ],
    pendingInteractions: [],
    transcriptCompleteness: "complete",
  } as const;
}

function queryRequestV11(
  requestId: string,
  method:
    | typeof RELAY_REQUEST_METHODS_V11.threadOpen
    | typeof RELAY_REQUEST_METHODS_V11.threadSnapshot
    | typeof RELAY_REQUEST_METHODS_V11.operationGet,
) {
  return relayRuntimeRequestSchemaV11.parse({
    type: "runtime.request",
    requestId,
    workspaceId: IDS.workspace,
    method,
    params:
      method === RELAY_REQUEST_METHODS_V11.operationGet
        ? { threadId: IDS.thread, operationId: IDS.operation }
        : { threadId: IDS.thread },
  });
}

function encryptedRequestEnvelopeV11(request: RelayRuntimeRequestV11, envelopeId: string) {
  return {
    type: "runtime.encrypted",
    workspaceId: request.workspaceId,
    envelopeId,
    payloadKind: "request",
    requestId: request.requestId,
    algorithm: "test-only-recording-cipher",
    nonce: `request-nonce-${request.requestId}`,
    ciphertext: `request-ciphertext-${request.requestId}`,
  } as const;
}

function sensitiveErrorCases() {
  return [
    {
      requestId: IDS.runtimeErrorRequest,
      envelopeId: IDS.runtimeErrorEnvelope,
      error: new RollRpcError({
        code: -32_000,
        message: `${SECRET_SENTINEL}:runtime`,
        data: { rollCode: "RUNTIME_CLOSING", retryable: true },
      }),
      expected: {
        code: "RUNTIME_CLOSING",
        message: "Runtime request failed",
        retryable: true,
      },
    },
    {
      requestId: IDS.deniedErrorRequest,
      envelopeId: IDS.deniedErrorEnvelope,
      error: new LocalApprovalDeniedError(`${SECRET_SENTINEL}:denied`),
      expected: {
        code: RELAY_ERROR_CODES.localApprovalDenied,
        message: "Local approval denied",
        retryable: false,
      },
    },
    {
      requestId: IDS.confirmationErrorRequest,
      envelopeId: IDS.confirmationErrorEnvelope,
      error: new LocalConfirmationRequiredError(`${SECRET_SENTINEL}:confirmation`),
      expected: {
        code: RELAY_ERROR_CODES.localConfirmationRequired,
        message: "Local confirmation required",
        retryable: false,
      },
    },
  ] as const;
}

test("Companion Wire 1.1 consumes the shared Relay conformance suite", () => {
  assert.deepEqual(
    runRelayProtocolConformanceForVersion("1.1", runtimeRelayProtocolConformanceAdapterV11),
    { protocolVersion: "1.1", passed: true, failures: [] },
  );
});

test("Wire 1.1 authorizes every remote request before cache lookup or Runtime dispatch", async () => {
  const workspace = new WorkspacePort();
  const responderContext = { subject: "authenticated-web-user" };
  const seen: Array<{
    readonly workspaceId: string;
    readonly requestId: string;
    readonly method: string;
    readonly responderContext: unknown;
    readonly signal: AbortSignal;
  }> = [];
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const transport = new MemoryRelayTransportV11();
  bridge.connect(transport, {
    requestPolicy: (input) => {
      seen.push(input);
      if (input.requestId === IDS.openRequest) {
        throw new Error(`${SECRET_SENTINEL}:request-policy`);
      }
      return false;
    },
    responderContext,
    responderPolicy: () => true,
  });
  await flush();

  const denied = queryRequestV11(IDS.snapshotRequest, RELAY_REQUEST_METHODS_V11.threadSnapshot);
  const failedClosed = queryRequestV11(IDS.openRequest, RELAY_REQUEST_METHODS_V11.threadOpen);
  transport.receive(denied);
  transport.receive(failedClosed);
  await flush();

  assert.equal(workspace.calls, 0);
  assert.equal(seen.length, 2);
  assert.deepEqual(
    {
      workspaceId: seen[0]?.workspaceId,
      requestId: seen[0]?.requestId,
      method: seen[0]?.method,
      responderContext: seen[0]?.responderContext,
    },
    {
      workspaceId: IDS.workspace,
      requestId: IDS.snapshotRequest,
      method: RELAY_REQUEST_METHODS_V11.threadSnapshot,
      responderContext,
    },
  );
  assert.ok(seen[0]?.signal instanceof AbortSignal);
  for (const request of [denied, failedClosed]) {
    assert.deepEqual(responseForV11(transport.sent, request.requestId).error, {
      code: RELAY_ERROR_CODES_V11.remoteRequestDenied,
      message: "Remote request denied",
      retryable: false,
    });
  }
  assert.equal(JSON.stringify(transport.sent).includes(SECRET_SENTINEL), false);
  bridge.close();
  assert.equal(seen[0]?.signal.aborted, true);
});

test("Wire 1.1 redacts sensitive Snapshot and operation.get query results", async () => {
  const workspace = new WorkspacePort((request) => {
    if (request.method === RELAY_REQUEST_METHODS_V11.operationGet) {
      return { operation: sensitiveOperation() };
    }
    if (
      request.method === RELAY_REQUEST_METHODS_V11.threadOpen ||
      request.method === RELAY_REQUEST_METHODS_V11.threadSnapshot
    ) {
      return sensitiveSnapshot();
    }
    throw new Error(`Unexpected query method: ${request.method}`);
  });
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const transport = new MemoryRelayTransportV11();
  bridge.connect(transport, {
    requestPolicy: () => true,
    responderContext: null,
    responderPolicy: () => true,
  });
  await flush();

  const requests = [
    queryRequestV11(IDS.snapshotRequest, RELAY_REQUEST_METHODS_V11.threadSnapshot),
    queryRequestV11(IDS.openRequest, RELAY_REQUEST_METHODS_V11.threadOpen),
    queryRequestV11(IDS.operationRequest, RELAY_REQUEST_METHODS_V11.operationGet),
  ];
  for (const request of requests) {
    transport.receive(request);
  }
  await flush();

  for (const request of requests) {
    const response = responseForV11(transport.sent, request.requestId);
    assert.equal(response.error, undefined);
    assert.equal(JSON.stringify(response).includes(SECRET_SENTINEL), false);
  }
  assert.equal(workspace.calls, 3);
  assert.deepEqual(responseForV11(transport.sent, IDS.operationRequest).result, {
    operation: {
      ...sensitiveOperation(),
      outcome: { kind: "tool_failed" },
      display: null,
    },
  });
  for (const requestId of [IDS.snapshotRequest, IDS.openRequest]) {
    const serialized = JSON.stringify(responseForV11(transport.sent, requestId).result);
    assert.equal(serialized.includes("rawToolOutput"), false);
    assert.equal(serialized.includes("Approve the deployment"), true);
  }
  bridge.close();
});

test("Wire 1.1 exposes only fixed public error messages in plaintext responses", async () => {
  const cases = sensitiveErrorCases();
  const workspace = new WorkspacePort((request) => {
    const failure = cases.find((entry) => entry.requestId === request.requestId);
    if (failure === undefined) {
      throw new Error(`Unexpected error fixture request: ${request.requestId}`);
    }
    throw failure.error;
  });
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const transport = new MemoryRelayTransportV11();
  bridge.connect(transport, {
    requestPolicy: () => true,
    responderContext: null,
    responderPolicy: () => true,
  });
  await flush();

  for (const entry of cases) {
    transport.receive(queryRequestV11(entry.requestId, RELAY_REQUEST_METHODS_V11.threadSnapshot));
  }
  await flush();

  for (const entry of cases) {
    const response = responseForV11(transport.sent, entry.requestId);
    assert.deepEqual(response.error, entry.expected);
    assert.equal(JSON.stringify(response).includes(SECRET_SENTINEL), false);
  }
  bridge.close();
});

test("Wire 1.1 redacts query results and errors before encrypting responses", async () => {
  const cases = sensitiveErrorCases();
  const workspace = new WorkspacePort((request) => {
    if (request.requestId === IDS.operationRequest) {
      return { operation: sensitiveOperation() };
    }
    const failure = cases.find((entry) => entry.requestId === request.requestId);
    if (failure === undefined) {
      throw new Error(`Unexpected encrypted fixture request: ${request.requestId}`);
    }
    throw failure.error;
  });
  const cipher = new RecordingRelayPayloadCipherV11();
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
    ciphers: new Map([[IDS.workspace, cipher]]),
  });
  const transport = new MemoryRelayTransportV11();
  bridge.connect(transport, {
    requestPolicy: () => true,
    responderContext: null,
    responderPolicy: () => true,
  });
  await flush();

  const operationRequest = queryRequestV11(
    IDS.operationRequest,
    RELAY_REQUEST_METHODS_V11.operationGet,
  );
  cipher.queueRequest(operationRequest);
  transport.receive(encryptedRequestEnvelopeV11(operationRequest, IDS.operationEnvelope));
  for (const entry of cases) {
    const request = queryRequestV11(entry.requestId, RELAY_REQUEST_METHODS_V11.threadSnapshot);
    cipher.queueRequest(request);
    transport.receive(encryptedRequestEnvelopeV11(request, entry.envelopeId));
  }
  await flush();

  const encryptedResponses = cipher.encryptedValues.map((value) =>
    relayRuntimeResponseSchemaV11.parse(value),
  );
  const operationResponse = responseForV11(encryptedResponses, IDS.operationRequest);
  assert.deepEqual(operationResponse.result, {
    operation: {
      ...sensitiveOperation(),
      outcome: { kind: "tool_failed" },
      display: null,
    },
  });
  assert.equal(JSON.stringify(operationResponse).includes(SECRET_SENTINEL), false);
  for (const entry of cases) {
    const response = responseForV11(encryptedResponses, entry.requestId);
    assert.deepEqual(response.error, entry.expected);
    assert.equal(JSON.stringify(response).includes(SECRET_SENTINEL), false);
  }
  assert.equal(JSON.stringify(cipher.encryptedValues).includes(SECRET_SENTINEL), false);
  assert.equal(JSON.stringify(transport.sent).includes(SECRET_SENTINEL), false);
  bridge.close();
});

test("Wire 1.1 mutation cache deduplicates candidates and rejects conflicts", async () => {
  const workspace = new WorkspacePort();
  let requestPolicyCalls = 0;
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const transport = new InMemoryRelayTransportV11();
  bridge.connect(transport, {
    requestPolicy: () => {
      requestPolicyCalls += 1;
      return true;
    },
    responderContext: null,
    responderPolicy: () => true,
  });

  transport.injectDuplicateCandidate({
    requestId: IDS.request,
    workspaceId: IDS.workspace,
    params: candidate(),
  });
  await flush();
  assert.equal(workspace.calls, 1);
  assert.equal(requestPolicyCalls, 2, "duplicates must be re-authorized before cache lookup");
  assert.equal(responses(transport.outbound).length, 2);
  assert.deepEqual(responses(transport.outbound)[0]?.result, { accepted: true });

  transport.injectCandidate({
    requestId: IDS.request,
    workspaceId: IDS.workspace,
    params: candidate("reject"),
  });
  await flush();
  assert.equal(workspace.calls, 1);
  assert.equal(requestPolicyCalls, 3, "conflicting requestIds must also be authorized first");
  assert.equal(responses(transport.outbound).at(-1)?.error?.code, "RELAY_REQUEST_ID_CONFLICT");
  bridge.close();
});

test("Wire 1.1 replays the same frame sequence after a send generation fails", async () => {
  const workspace = new WorkspacePort();
  const original = workspace.appendInteraction();
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const first = new InMemoryRelayTransportV11();
  bridge.connect(first, {
    requestPolicy: () => true,
    responderContext: "first",
    responderPolicy: () => true,
  });
  await flush();
  first.disconnect();

  const second = new InMemoryRelayTransportV11();
  bridge.connect(second, {
    requestPolicy: () => true,
    responderContext: "second",
    responderPolicy: () => true,
  });
  await flush();
  const replay = second.outbound.find(
    (message): message is Extract<RelayMessageV11, { readonly type: "interaction.request" }> =>
      message.type === "interaction.request",
  );
  assert.equal(replay?.relaySequence, original.relaySequence);
  bridge.close();
  assert.equal(workspace.closeCalls, 1);
});

test("Wire 1.1 ACK advances only through the prefix advertised on that generation", async () => {
  const workspace = new WorkspacePort();
  workspace.appendInteraction("approve");
  workspace.appendInteraction("reject");
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const first = new InMemoryRelayTransportV11();
  bridge.connect(first, {
    requestPolicy: () => true,
    responderContext: null,
    responderPolicy: () => true,
  });
  await flush();
  first.injectAck(IDS.workspace, 0);
  await flush();
  assert.equal(workspace.frames.size, 1);

  first.injectAck(IDS.workspace, 99);
  await flush();
  assert.equal(workspace.frames.size, 1, "ACK beyond the advertised prefix must be ignored");
  first.disconnect();

  const second = new InMemoryRelayTransportV11();
  bridge.connect(second, {
    requestPolicy: () => true,
    responderContext: null,
    responderPolicy: () => true,
  });
  await flush();
  const replayed = second.outbound.filter(
    (message): message is Extract<RelayMessageV11, { readonly type: "interaction.request" }> =>
      message.type === "interaction.request",
  );
  assert.deepEqual(
    replayed.map((message) => message.relaySequence),
    [1],
  );
  bridge.close();
});

test("Wire 1.1 encrypts Interaction frames as interaction payloads", async () => {
  const workspace = new WorkspacePort();
  workspace.appendInteraction();
  const encryptedValues: unknown[] = [];
  const cipher: RelayPayloadCipherV11 = {
    algorithm: "fixture-aead",
    async encrypt(value) {
      encryptedValues.push(value);
      return { nonce: "fixture-nonce", ciphertext: "fixture-ciphertext" };
    },
    async decrypt() {
      throw new Error("decrypt is not used by this fixture");
    },
  };
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
    ciphers: new Map([[IDS.workspace, cipher]]),
  });
  const transport = new InMemoryRelayTransportV11();
  bridge.connect(transport, {
    requestPolicy: () => true,
    responderContext: null,
    responderPolicy: () => true,
  });
  await flush();

  const encrypted = transport.outbound.find(
    (message): message is Extract<RelayMessageV11, { readonly type: "runtime.encrypted" }> =>
      message.type === "runtime.encrypted" && message.payloadKind === "interaction",
  );
  assert.ok(encrypted);
  assert.equal(encrypted.relaySequence, 0);
  const encryptedValue = encryptedValues[0];
  assert.ok(typeof encryptedValue === "object" && encryptedValue !== null);
  assert.equal(Reflect.get(encryptedValue, "type"), "interaction.request");
  bridge.close();
});

test("Outbound Wire 1.1 connections forward the required request policy", async () => {
  const workspace = new WorkspacePort();
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const transport = new MemoryRelayTransportV11();
  let requestPolicyCalls = 0;
  const outbound = new OutboundCompanionRelayV11({
    bridge,
    connectTransport: async () => ({
      transport,
      requestPolicy: () => {
        requestPolicyCalls += 1;
        return true;
      },
      responderContext: { subject: "web-user" },
      responderPolicy: () => true,
    }),
    minReconnectMs: 1,
    maxReconnectMs: 2,
  });

  outbound.start();
  await flush();
  transport.receive(queryRequestV11(IDS.snapshotRequest, RELAY_REQUEST_METHODS_V11.threadSnapshot));
  await flush();

  assert.equal(requestPolicyCalls, 1);
  assert.equal(workspace.calls, 1);
  outbound.stop();
});
