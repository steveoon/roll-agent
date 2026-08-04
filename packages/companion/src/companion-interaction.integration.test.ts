import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_SERVER_REQUEST_METHODS,
  approvalRequestParamsV12Schema,
  runtimeEventEnvelopeSchema,
  userInputRequestParamsV12Schema,
  type InitializeResult,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodInput,
  type RuntimeMethodResult,
} from "@roll-agent/protocol";
import {
  RELAY_INTERACTION_METHODS_V11,
  deviceIdSchema,
  relayInteractionIdSchema,
  relayApprovalInteractionRequestSchemaV11,
  relayInteractionCandidateParamsSchemaV11,
  relayRequestIdSchema,
  relayUserInputInteractionRequestSchemaV11,
  workspaceIdSchema,
  type RelayMessageV11,
} from "@roll-agent/relay-protocol";
import type { CompanionRuntimeClient } from "./companion-workspace.ts";
import { CompanionWorkspace } from "./companion-workspace.ts";
import {
  CompanionInteractionBroker,
  createRuntimeServerRequestHandlers,
} from "./interaction-broker.ts";
import { CompanionRelayBridgeV11 } from "./relay-bridge-v11.ts";
import { InMemoryRelayTransportV11 } from "./testing.ts";

const IDS = {
  device: deviceIdSchema.parse("00000000-0000-4000-8000-000000000101"),
  workspace: workspaceIdSchema.parse("00000000-0000-4000-8000-000000000102"),
  runtime: "00000000-0000-4000-8000-000000000111",
  thread: "00000000-0000-4000-8000-000000000103",
  turn: "00000000-0000-4000-8000-000000000104",
  approval: "00000000-0000-4000-8000-000000000105",
  approvalInteraction: relayInteractionIdSchema.parse("00000000-0000-4000-8000-000000000106"),
  inputInteraction: relayInteractionIdSchema.parse("00000000-0000-4000-8000-000000000107"),
  candidateOne: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000108"),
  candidateTwo: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000109"),
  candidateThree: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000110"),
} as const;

class ProtocolV12Client implements CompanionRuntimeClient {
  private readonly listeners = new Set<(event: RuntimeEventEnvelope) => void>();

  request<TMethod extends RuntimeMethod>(
    _method: TMethod,
    _input: RuntimeMethodInput<TMethod>,
  ): Promise<RuntimeMethodResult<TMethod>> {
    return Promise.reject(new Error("This integration fixture does not call Runtime methods"));
  }

  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getInitializationResult(): Pick<InitializeResult, "protocolVersion"> {
    return { protocolVersion: "1.2" };
  }

  emit(event: RuntimeEventEnvelope): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  close(): void {}
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushBridge(): Promise<void> {
  await nextTask();
  await nextTask();
}

function messagesOfType<TType extends RelayMessageV11["type"]>(
  messages: readonly RelayMessageV11[],
  type: TType,
): Array<Extract<RelayMessageV11, { readonly type: TType }>> {
  return messages.filter(
    (message): message is Extract<RelayMessageV11, { readonly type: TType }> =>
      message.type === type,
  );
}

test("the Runtime handler manifest excludes local-only interactions", () => {
  const handlers = createRuntimeServerRequestHandlers(new CompanionInteractionBroker());
  assert.deepEqual(Object.keys(handlers).sort(), ["approval.request", "userInput.request"]);
  assert.equal("authentication.request" in handlers, false);
  assert.equal("filePicker.request" in handlers, false);
});

test("Runtime Protocol 1.2 fails closed when no Interaction Broker is configured", () => {
  assert.throws(
    () =>
      new CompanionWorkspace({
        client: new ProtocolV12Client(),
        localApprovalPolicy: () => "deny",
      }),
    /requires a CompanionInteractionBroker/u,
  );
});

test(
  "an approval timeline event is safe and cannot act as the remote control path",
  { timeout: 5_000 },
  async () => {
    const client = new ProtocolV12Client();
    const broker = new CompanionInteractionBroker();
    let localPolicyCalls = 0;
    const workspace = new CompanionWorkspace({
      client,
      workspaceId: IDS.workspace,
      interactionBroker: broker,
      localApprovalPolicy: () => {
        localPolicyCalls += 1;
        return "allow";
      },
    });
    const bridge = new CompanionRelayBridgeV11({
      deviceId: IDS.device,
      pairingToken: "pairing-token-long-enough",
      workspaces: new Map([[IDS.workspace, workspace]]),
    });
    const transport = new InMemoryRelayTransportV11();
    bridge.connect(transport, { responderContext: null, responderPolicy: () => true });

    client.emit(
      runtimeEventEnvelopeSchema.parse({
        protocolVersion: "1.2",
        runtimeInstanceId: IDS.runtime,
        sequence: 0,
        timestamp: "2026-08-04T12:00:00.000Z",
        threadId: IDS.thread,
        turnId: IDS.turn,
        event: {
          type: "approval.required",
          approval: {
            id: IDS.approval,
            turnId: IDS.turn,
            agentName: "timeline-agent",
            toolName: "timeline-tool",
            preview: {
              explanation: "Safe timeline explanation",
              secret: "SENTINEL_TIMELINE_SECRET",
            },
          },
        },
      }),
    );
    await flushBridge();

    const events = messagesOfType(transport.outbound, "runtime.event");
    assert.equal(events.length, 1);
    assert.equal(messagesOfType(transport.outbound, "interaction.request").length, 0);
    assert.doesNotMatch(JSON.stringify(events[0]), /SENTINEL_TIMELINE_SECRET/u);

    transport.injectCandidate({
      requestId: IDS.candidateOne,
      workspaceId: IDS.workspace,
      params: relayInteractionCandidateParamsSchemaV11.parse({
        interactionId: IDS.approvalInteraction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
        candidate: { decision: "approve" },
      }),
    });
    await flushBridge();

    assert.equal(localPolicyCalls, 0);
    assert.equal(
      messagesOfType(transport.outbound, "runtime.response").at(-1)?.error?.code,
      "COMPANION_ERROR",
    );
    bridge.close();
  },
);

test(
  "Wire 1.1 projects a safe Approval and preserves local policy authority",
  { timeout: 5_000 },
  async () => {
    const broker = new CompanionInteractionBroker();
    let policyPreview: unknown;
    const workspace = new CompanionWorkspace({
      client: new ProtocolV12Client(),
      workspaceId: IDS.workspace,
      interactionBroker: broker,
      localApprovalPolicy: (approval) => {
        policyPreview = approval.preview;
        return "allow";
      },
    });
    const responderContext = { authenticatedSession: "host-owned" };
    let seenResponderContext: unknown;
    const bridge = new CompanionRelayBridgeV11({
      deviceId: IDS.device,
      pairingToken: "pairing-token-long-enough",
      workspaces: new Map([[IDS.workspace, workspace]]),
    });
    const transport = new InMemoryRelayTransportV11();
    bridge.connect(transport, {
      responderContext,
      responderPolicy: (input) => {
        seenResponderContext = input.responderContext;
        return true;
      },
    });

    const handlers = createRuntimeServerRequestHandlers(broker);
    const approvalHandler = handlers[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
    assert.ok(approvalHandler);
    const runtimeResult = approvalHandler(
      approvalRequestParamsV12Schema.parse({
        interactionId: IDS.approvalInteraction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        expiresAt: "2099-08-04T12:00:00.000Z",
        sensitivity: "normal",
        approval: {
          id: IDS.approval,
          turnId: IDS.turn,
          agentName: "deploy-agent",
          toolName: "deploy-workspace",
          preview: {
            rawToolInput: "SENTINEL_RAW_TOOL_INPUT",
            secret: "SENTINEL_SECRET",
            explanation: "Deploy the selected Workspace",
          },
        },
      }),
      { requestId: "runtime-json-rpc-private-id", signal: new AbortController().signal },
    );
    await flushBridge();

    const requests = messagesOfType(transport.outbound, "interaction.request");
    assert.equal(requests.length, 1);
    const request = relayApprovalInteractionRequestSchemaV11.parse(requests[0]);
    assert.deepEqual(Object.keys(request.projection).sort(), [
      "agentName",
      "approvalId",
      "explanation",
      "toolName",
    ]);
    const serialized = JSON.stringify(request);
    assert.doesNotMatch(serialized, /runtime-json-rpc-private-id/u);
    assert.doesNotMatch(serialized, /SENTINEL_RAW_TOOL_INPUT|SENTINEL_SECRET/u);

    transport.injectCandidate({
      requestId: IDS.candidateOne,
      workspaceId: IDS.workspace,
      params: relayInteractionCandidateParamsSchemaV11.parse({
        interactionId: IDS.approvalInteraction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
        candidate: { decision: "approve" },
      }),
    });
    assert.deepEqual(await runtimeResult, { decision: "approve" });
    await flushBridge();

    assert.deepEqual(policyPreview, {
      rawToolInput: "SENTINEL_RAW_TOOL_INPUT",
      secret: "SENTINEL_SECRET",
      explanation: "Deploy the selected Workspace",
    });
    assert.equal(seenResponderContext, responderContext);
    assert.equal(messagesOfType(transport.outbound, "interaction.resolved").length, 1);
    assert.deepEqual(messagesOfType(transport.outbound, "runtime.response").at(-1)?.result, {
      accepted: true,
    });
    bridge.close();
  },
);

test(
  "Wire 1.1 validates all User Input controls against the original form",
  { timeout: 5_000 },
  async () => {
    const broker = new CompanionInteractionBroker();
    const workspace = new CompanionWorkspace({
      client: new ProtocolV12Client(),
      workspaceId: IDS.workspace,
      interactionBroker: broker,
      localApprovalPolicy: () => "deny",
    });
    const bridge = new CompanionRelayBridgeV11({
      deviceId: IDS.device,
      pairingToken: "pairing-token-long-enough",
      workspaces: new Map([[IDS.workspace, workspace]]),
    });
    const transport = new InMemoryRelayTransportV11();
    bridge.connect(transport, { responderContext: null, responderPolicy: () => true });

    const handlers = createRuntimeServerRequestHandlers(broker);
    const userInputHandler = handlers[RUNTIME_SERVER_REQUEST_METHODS.userInputRequest];
    assert.ok(userInputHandler);
    const runtimeResult = userInputHandler(
      userInputRequestParamsV12Schema.parse({
        interactionId: IDS.inputInteraction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        expiresAt: "2099-08-04T12:00:00.000Z",
        sensitivity: "normal",
        title: "Target Workspace",
        description: "Choose deployment inputs",
        controls: [
          { type: "text", id: "region", label: "Deployment region", required: true },
          { type: "multiline", id: "notes", label: "Notes", required: false },
          { type: "number", id: "replicas", label: "Replicas", required: true, min: 1 },
          { type: "boolean", id: "canary", label: "Canary", required: true },
          {
            type: "choice",
            id: "workspace",
            label: "Workspace",
            required: true,
            multiple: false,
            options: [
              { id: "north", label: "North" },
              { id: "south", label: "South" },
            ],
          },
        ],
      }),
      { requestId: 90210, signal: new AbortController().signal },
    );
    await flushBridge();

    const request = relayUserInputInteractionRequestSchemaV11.parse(
      messagesOfType(transport.outbound, "interaction.request").at(-1),
    );
    assert.equal(request.projection.controls.length, 5);
    assert.equal("requestId" in request, false);

    transport.injectCandidate({
      requestId: IDS.candidateOne,
      workspaceId: IDS.workspace,
      params: relayInteractionCandidateParamsSchemaV11.parse({
        interactionId: IDS.inputInteraction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
        candidate: {
          status: "submitted",
          values: [{ id: "unknown", value: "no" }],
        },
      }),
    });
    await flushBridge();
    assert.equal(messagesOfType(transport.outbound, "interaction.resolved").length, 0);
    assert.equal(
      messagesOfType(transport.outbound, "runtime.response").at(-1)?.error?.code,
      "COMPANION_ERROR",
    );

    transport.injectCandidate({
      requestId: IDS.candidateTwo,
      workspaceId: IDS.workspace,
      params: relayInteractionCandidateParamsSchemaV11.parse({
        interactionId: IDS.inputInteraction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
        candidate: {
          status: "submitted",
          values: [
            { id: "workspace", value: "south" },
            { id: "canary", value: true },
            { id: "replicas", value: 3 },
            { id: "notes", value: "gradual rollout" },
            { id: "region", value: "ap-southeast-1" },
          ],
        },
      }),
    });
    await flushBridge();
    const validCandidateResponse = messagesOfType(transport.outbound, "runtime.response").at(-1);
    assert.deepEqual(validCandidateResponse?.error, undefined);
    assert.deepEqual(validCandidateResponse?.result, { accepted: true });
    assert.deepEqual(await runtimeResult, {
      status: "submitted",
      values: [
        { id: "region", value: "ap-southeast-1" },
        { id: "notes", value: "gradual rollout" },
        { id: "replicas", value: 3 },
        { id: "canary", value: true },
        { id: "workspace", value: "south" },
      ],
    });
    bridge.close();
  },
);

test(
  "the same candidate requestId can retry immediately on a new generation",
  { timeout: 5_000 },
  async () => {
    const broker = new CompanionInteractionBroker();
    const workspace = new CompanionWorkspace({
      client: new ProtocolV12Client(),
      workspaceId: IDS.workspace,
      interactionBroker: broker,
      localApprovalPolicy: () => "allow",
    });
    const bridge = new CompanionRelayBridgeV11({
      deviceId: IDS.device,
      pairingToken: "pairing-token-long-enough",
      workspaces: new Map([[IDS.workspace, workspace]]),
    });
    const firstPolicyStarted = Promise.withResolvers<void>();
    const firstPolicyResult = Promise.withResolvers<boolean>();
    const firstTransport = new InMemoryRelayTransportV11();
    bridge.connect(firstTransport, {
      responderContext: "first-generation",
      responderPolicy: () => {
        firstPolicyStarted.resolve();
        return firstPolicyResult.promise;
      },
    });

    const approvalHandler =
      createRuntimeServerRequestHandlers(broker)[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
    assert.ok(approvalHandler);
    const runtimeResult = approvalHandler(
      approvalRequestParamsV12Schema.parse({
        interactionId: IDS.approvalInteraction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        expiresAt: "2099-08-04T12:00:00.000Z",
        sensitivity: "normal",
        approval: {
          id: IDS.approval,
          turnId: IDS.turn,
          agentName: "deploy-agent",
          toolName: "deploy-workspace",
          preview: {},
        },
      }),
      { requestId: "private-runtime-id", signal: new AbortController().signal },
    );
    await flushBridge();
    const params = relayInteractionCandidateParamsSchemaV11.parse({
      interactionId: IDS.approvalInteraction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
      candidate: { decision: "approve" },
    });
    firstTransport.injectCandidate({
      requestId: IDS.candidateOne,
      workspaceId: IDS.workspace,
      params,
    });
    await firstPolicyStarted.promise;
    firstTransport.disconnect();
    firstTransport.injectLateCandidate({
      requestId: IDS.candidateThree,
      workspaceId: IDS.workspace,
      params,
    });

    let secondPolicyCalls = 0;
    const secondTransport = new InMemoryRelayTransportV11();
    bridge.connect(secondTransport, {
      responderContext: "second-generation",
      responderPolicy: () => {
        secondPolicyCalls += 1;
        return true;
      },
    });
    secondTransport.injectCandidate({
      requestId: IDS.candidateOne,
      workspaceId: IDS.workspace,
      params,
    });
    assert.deepEqual(await runtimeResult, { decision: "approve" });
    assert.equal(secondPolicyCalls, 1);
    firstPolicyResult.resolve(true);
    await flushBridge();

    const firstRequest = relayApprovalInteractionRequestSchemaV11.parse(
      messagesOfType(firstTransport.outbound, "interaction.request")[0],
    );
    const replayedRequest = relayApprovalInteractionRequestSchemaV11.parse(
      messagesOfType(secondTransport.outbound, "interaction.request")[0],
    );
    assert.equal(replayedRequest.relaySequence, firstRequest.relaySequence);
    assert.equal(messagesOfType(secondTransport.outbound, "interaction.resolved").length, 1);
    bridge.close();
  },
);
