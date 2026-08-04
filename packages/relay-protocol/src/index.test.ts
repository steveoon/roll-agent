import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectRuntimeEventEnvelopeForVersion,
  projectThreadSnapshotForVersion,
  runtimeEventEnvelopeSchema,
} from "@roll-agent/protocol";
import {
  RELAY_ERROR_CODES,
  RELAY_ERROR_RETRYABILITY,
  RELAY_INTERACTION_METHODS_V11,
  RELAY_MESSAGE_TYPE_VALUES,
  RELAY_MESSAGE_TYPE_VALUES_V11,
  RELAY_MUTATION_REQUEST_METHODS,
  LATEST_RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_REGISTRY,
  RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_METHODS_V11,
  RELAY_REQUEST_METHOD_VALUES_V11,
  RELAY_REQUEST_REPLAY_DISPOSITIONS,
  RELAY_REQUEST_METHODS,
  RELAY_REQUEST_METHOD_DISPOSITIONS,
  RELAY_REQUEST_METHOD_VALUES,
  SUPPORTED_RELAY_PROTOCOL_VERSIONS,
  classifyRelayAck,
  classifyRelayRequestReplay,
  getRelayRequestMethodDisposition,
  getRelayRequestMethodDispositionForVersion,
  getRelayProtocolRegistry,
  getRelayErrorRetryability,
  isRelayMutationRequestMethod,
  negotiateRelayProtocolVersion,
  parseRelayInteractionCandidateForRequestV11,
  parseRelayMessageForVersion,
  parseRelayRequestParams,
  parseRelayRequestParamsForVersion,
  parseRelayRequestResult,
  projectRuntimeEventEnvelopeForRelayV11,
  relayDeviceConnectSchema,
  relayInteractionCancelledSchemaV11,
  relayInteractionRequestSchemaV11,
  relayInteractionResolvedSchemaV11,
  relayRuntimeEventSchema,
  relayRuntimeEventSchemaV11,
  relayRuntimeRequestSchema,
  relayRuntimeRequestSchemaV11,
} from "./index.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000609",
  thread: "00000000-0000-4000-8000-000000000601",
  turn: "00000000-0000-4000-8000-000000000602",
  approval: "00000000-0000-4000-8000-000000000603",
  request: "00000000-0000-4000-8000-000000000604",
  secondRequest: "00000000-0000-4000-8000-000000000607",
  device: "00000000-0000-4000-8000-000000000605",
  workspace: "00000000-0000-4000-8000-000000000606",
  secondWorkspace: "00000000-0000-4000-8000-000000000608",
  interaction: "00000000-0000-4000-8000-000000000610",
} as const;

test("Relay Protocol v1.0 freezes message and request registries", () => {
  assert.equal(RELAY_PROTOCOL_VERSION, "1.0");
  assert.equal(LATEST_RELAY_PROTOCOL_VERSION, "1.1");
  assert.deepEqual(SUPPORTED_RELAY_PROTOCOL_VERSIONS, ["1.1", "1.0"]);
  assert.deepEqual(RELAY_MESSAGE_TYPE_VALUES, [
    "device.connect",
    "runtime.request",
    "runtime.response",
    "runtime.event",
    "runtime.ack",
    "runtime.gap",
    "runtime.encrypted",
  ]);
  assert.deepEqual(RELAY_REQUEST_METHOD_VALUES, [
    "initialize",
    "thread.list",
    "thread.create",
    "thread.open",
    "thread.snapshot",
    "thread.rename",
    "thread.delete",
    "thread.detach",
    "thread.capabilities",
    "turn.start",
    "turn.cancel",
    "approval.respond",
    "operation.get",
    "approval.candidate",
  ]);
  assert.deepEqual(getRelayProtocolRegistry("1.0"), RELAY_PROTOCOL_REGISTRY["1.0"]);
});

test("Relay Wire 1.1 registers typed interactions without legacy approval mutations", () => {
  assert.deepEqual(RELAY_MESSAGE_TYPE_VALUES_V11, [
    ...RELAY_MESSAGE_TYPE_VALUES,
    "interaction.request",
    "interaction.resolved",
    "interaction.cancelled",
  ]);
  assert.deepEqual(RELAY_REQUEST_METHOD_VALUES_V11, [
    "initialize",
    "thread.list",
    "thread.create",
    "thread.open",
    "thread.snapshot",
    "thread.rename",
    "thread.delete",
    "thread.detach",
    "thread.capabilities",
    "turn.start",
    "turn.cancel",
    "operation.get",
    "interaction.candidate",
  ]);
  assert.equal(
    getRelayRequestMethodDispositionForVersion("1.1", "interaction.candidate"),
    "mutation",
  );
  assert.equal(getRelayRequestMethodDispositionForVersion("1.1", "approval.respond"), undefined);
  assert.equal(getRelayRequestMethodDispositionForVersion("1.1", "approval.candidate"), undefined);
  assert.equal(getRelayRequestMethodDispositionForVersion("1.0", "approval.candidate"), "mutation");
  assert.equal(negotiateRelayProtocolVersion(["1.0", "1.1"]), "1.1");
});

test("version-aware frame parsing cannot smuggle interactions into Wire 1.0", () => {
  const request = {
    type: "interaction.request",
    workspaceId: IDS.workspace,
    relaySequence: 4,
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
    expiresAt: "2026-08-04T12:05:00.000Z",
    sensitivity: "normal",
    projection: {
      approvalId: IDS.approval,
      agentName: "workspace",
      toolName: "write_file",
      explanation: "写入用户明确要求的文件。",
    },
  } as const;
  assert.equal(parseRelayMessageForVersion("1.1", request).type, "interaction.request");
  assert.throws(() => parseRelayMessageForVersion("1.0", request));
  assert.throws(() =>
    relayInteractionRequestSchemaV11.parse({
      ...request,
      projection: {
        ...request.projection,
        input: { command: "secret command" },
      },
    }),
  );
  assert.throws(() =>
    relayInteractionRequestSchemaV11.parse({
      ...request,
      sensitivity: "secret",
    }),
  );
  assert.throws(() =>
    relayInteractionResolvedSchemaV11.parse({
      type: "interaction.resolved",
      workspaceId: IDS.workspace,
      relaySequence: 5,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: request.method,
      result: { decision: "approve" },
    }),
  );
  assert.throws(() =>
    relayInteractionCancelledSchemaV11.parse({
      type: "interaction.cancelled",
      workspaceId: IDS.workspace,
      relaySequence: 5,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: request.method,
      reason: "local token: must-not-cross-wire",
    }),
  );
});

test("interaction candidates are method-specific and User Input is correlated to its form", () => {
  const request = relayInteractionRequestSchemaV11.parse({
    type: "interaction.request",
    workspaceId: IDS.workspace,
    relaySequence: 7,
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
    expiresAt: "2026-08-04T12:05:00.000Z",
    sensitivity: "normal",
    projection: {
      title: "部署配置",
      controls: [
        {
          type: "choice",
          id: "region",
          label: "部署区域",
          required: true,
          multiple: false,
          options: [
            { id: "east", label: "华东" },
            { id: "west", label: "华西" },
          ],
        },
        {
          type: "text",
          id: "workspace",
          label: "目标 Workspace",
          required: true,
        },
      ],
    },
  });
  assert.deepEqual(
    parseRelayInteractionCandidateForRequestV11(request, {
      status: "submitted",
      values: [
        { id: "workspace", value: "production" },
        { id: "region", value: "east" },
      ],
    }).candidate,
    {
      status: "submitted",
      values: [
        { id: "region", value: "east" },
        { id: "workspace", value: "production" },
      ],
    },
  );
  assert.throws(() =>
    parseRelayInteractionCandidateForRequestV11(request, {
      status: "submitted",
      values: [
        { id: "region", value: "north" },
        { id: "workspace", value: "production" },
      ],
    }),
  );
  assert.throws(() =>
    parseRelayRequestParamsForVersion("1.1", RELAY_REQUEST_METHODS_V11.interactionCandidate, {
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
      candidate: { status: "submitted", values: [] },
    }),
  );
  assert.throws(() =>
    relayRuntimeRequestSchemaV11.parse({
      type: "runtime.request",
      requestId: IDS.request,
      workspaceId: IDS.workspace,
      method: "approval.respond",
      params: {},
    }),
  );
});

test("Relay Wire 1.1 timeline projector strips Tool data and Approval preview", () => {
  const toolStarted = runtimeEventEnvelopeSchema.parse({
    protocolVersion: "1.2",
    runtimeInstanceId: IDS.runtime,
    sequence: 8,
    timestamp: "2026-08-04T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event: {
      type: "tool.started",
      toolCallId: "tool-1",
      agentName: "workspace",
      toolName: "exec",
      input: { command: "secret command" },
    },
  });
  const projected = projectRuntimeEventEnvelopeForRelayV11(toolStarted);
  assert.ok(projected?.event.type === "tool.started");
  assert.equal("input" in projected.event, false);
  assert.equal(
    relayRuntimeEventSchemaV11.parse({
      type: "runtime.event",
      workspaceId: IDS.workspace,
      relaySequence: 8,
      event: projected,
    }).event.protocolVersion,
    "1.1",
  );
  assert.throws(() =>
    relayRuntimeEventSchemaV11.parse({
      type: "runtime.event",
      workspaceId: IDS.workspace,
      relaySequence: 8,
      event: toolStarted,
    }),
  );

  assert.equal(
    projectRuntimeEventEnvelopeForRelayV11({
      ...toolStarted,
      event: {
        type: "tool.output",
        toolCallId: "tool-1",
        agentName: "workspace",
        toolName: "exec",
        stream: "stdout",
        delta: "secret output",
      },
    }),
    undefined,
  );

  const approval = projectRuntimeEventEnvelopeForRelayV11({
    ...toolStarted,
    event: {
      type: "approval.required",
      approval: {
        id: IDS.approval,
        turnId: IDS.turn,
        agentName: "workspace",
        toolName: "exec",
        preview: {
          command: "secret command",
          explanation: "运行测试以验证修改。",
        },
        reason: "local policy detail",
      },
    },
  });
  assert.ok(approval?.event.type === "approval.required");
  assert.deepEqual(approval.event.approval, {
    approvalId: IDS.approval,
    agentName: "workspace",
    toolName: "exec",
    explanation: "运行测试以验证修改。",
  });
});

test("every frozen Relay method has one explicit disposition", () => {
  assert.deepEqual(
    Object.keys(RELAY_REQUEST_METHOD_DISPOSITIONS).sort(),
    [...RELAY_REQUEST_METHOD_VALUES].sort(),
  );
  assert.deepEqual(
    RELAY_REQUEST_METHOD_VALUES.filter(isRelayMutationRequestMethod),
    RELAY_MUTATION_REQUEST_METHODS,
  );
  assert.equal(isRelayMutationRequestMethod(RELAY_REQUEST_METHODS.threadSnapshot), false);
  assert.equal(getRelayRequestMethodDisposition(RELAY_REQUEST_METHODS.initialize), "local-only");
  assert.equal(getRelayRequestMethodDisposition(RELAY_REQUEST_METHODS.threadSnapshot), "query");
  assert.equal(getRelayRequestMethodDisposition("runtime.futureMethod"), undefined);
});

test("every stable Relay error code has one retryability decision", () => {
  assert.deepEqual(
    Object.keys(RELAY_ERROR_RETRYABILITY).sort(),
    Object.values(RELAY_ERROR_CODES).sort(),
  );
  for (const code of Object.values(RELAY_ERROR_CODES)) {
    assert.equal(getRelayErrorRetryability(code), false);
  }
});

test("version selection fails closed for unknown Relay versions", () => {
  assert.equal(negotiateRelayProtocolVersion(["1.0"]), "1.0");
  assert.equal(negotiateRelayProtocolVersion(["9.9", "1.0"]), "1.0");
  assert.equal(negotiateRelayProtocolVersion(["9.9"]), undefined);
  assert.throws(() =>
    relayDeviceConnectSchema.parse({
      type: "device.connect",
      protocolVersion: "9.9",
      deviceId: IDS.device,
      pairingToken: "pairing-token-with-sufficient-length",
    }),
  );
});

test("method-specific parsing validates approval candidates", () => {
  assert.equal(
    parseRelayRequestParams(RELAY_REQUEST_METHODS.approvalCandidate, {
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    }).decision,
    "approve",
  );
  assert.throws(() =>
    parseRelayRequestParams(RELAY_REQUEST_METHODS.approvalCandidate, {
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "reject",
      reason: "",
    }),
  );
});

test("Relay Wire 1.0 accepts only projected Runtime 1.1 events and snapshots", () => {
  const latestEvent = runtimeEventEnvelopeSchema.parse({
    protocolVersion: "1.2",
    runtimeInstanceId: IDS.runtime,
    sequence: 0,
    timestamp: "2026-07-30T00:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event: { type: "turn.completed" },
  });
  const latestEventFrame = {
    type: "runtime.event",
    workspaceId: IDS.workspace,
    relaySequence: 0,
    event: latestEvent,
  } as const;

  assert.throws(() => relayRuntimeEventSchema.parse(latestEventFrame));
  const projectedEvent = projectRuntimeEventEnvelopeForVersion("1.1", latestEvent);
  assert.equal(
    relayRuntimeEventSchema.parse({
      ...latestEventFrame,
      event: projectedEvent,
    }).event.protocolVersion,
    "1.1",
  );

  const latestSnapshot = projectThreadSnapshotForVersion("1.2", {
    thread: {
      id: IDS.thread,
      title: "Relay projection",
      model: "mock",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    pendingInteractions: [
      {
        method: "approval.request",
        interactionId: IDS.interaction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        expiresAt: "2026-07-30T00:05:00.000Z",
        sensitivity: "normal",
        approvalId: IDS.approval,
      },
    ],
    transcriptCompleteness: "complete",
  });

  assert.throws(() =>
    parseRelayRequestResult(RELAY_REQUEST_METHODS.threadSnapshot, latestSnapshot),
  );
  const projectedSnapshot = projectThreadSnapshotForVersion("1.1", latestSnapshot);
  const parsedSnapshot = parseRelayRequestResult(
    RELAY_REQUEST_METHODS.threadSnapshot,
    projectedSnapshot,
  );
  assert.equal(parsedSnapshot.thread.id, IDS.thread);
  assert.equal("pendingInteractions" in parsedSnapshot, false);
});

test("replay classification uses workspace and request IDs as the idempotency key", () => {
  const first = relayRuntimeRequestSchema.parse({
    type: "runtime.request",
    requestId: IDS.request,
    workspaceId: IDS.workspace,
    method: "thread.snapshot",
    params: { threadId: IDS.thread, limit: 100 },
  });
  const reordered = relayRuntimeRequestSchema.parse({
    ...first,
    params: { limit: 100, threadId: IDS.thread },
  });
  const conflicting = relayRuntimeRequestSchema.parse({
    ...first,
    params: { threadId: IDS.thread, limit: 10 },
  });
  const conflictingMethod = relayRuntimeRequestSchema.parse({
    ...first,
    method: RELAY_REQUEST_METHODS.threadOpen,
  });
  const differentRequest = relayRuntimeRequestSchema.parse({
    ...first,
    requestId: IDS.secondRequest,
  });
  const differentWorkspace = relayRuntimeRequestSchema.parse({
    ...first,
    workspaceId: IDS.secondWorkspace,
  });
  assert.deepEqual(classifyRelayRequestReplay(first, reordered), {
    disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.replay,
  });
  assert.deepEqual(classifyRelayRequestReplay(first, conflicting), {
    disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.conflict,
    errorCode: RELAY_ERROR_CODES.requestIdConflict,
  });
  assert.deepEqual(classifyRelayRequestReplay(first, conflictingMethod), {
    disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.conflict,
    errorCode: RELAY_ERROR_CODES.requestIdConflict,
  });
  assert.deepEqual(classifyRelayRequestReplay(first, differentRequest), {
    disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.new,
  });
  assert.deepEqual(classifyRelayRequestReplay(first, differentWorkspace), {
    disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.new,
  });
});

test("ACK classification uses the caller-proven contiguous delivery prefix", () => {
  const cases = [
    {
      state: { acknowledgedThrough: -1, advertisedThrough: 0, incomingThrough: 0 },
      expected: "advance",
    },
    {
      state: { acknowledgedThrough: 0, advertisedThrough: 2, incomingThrough: 2 },
      expected: "advance",
    },
    {
      state: { acknowledgedThrough: 2, advertisedThrough: 2, incomingThrough: 2 },
      expected: "duplicate",
    },
    {
      state: { acknowledgedThrough: 2, advertisedThrough: 2, incomingThrough: 1 },
      expected: "duplicate",
    },
    {
      state: { acknowledgedThrough: 0, advertisedThrough: 1, incomingThrough: 2 },
      expected: "invalid",
    },
    {
      state: { acknowledgedThrough: 0, advertisedThrough: 1, incomingThrough: 0.5 },
      expected: "invalid",
    },
    {
      state: { acknowledgedThrough: -2, advertisedThrough: 0, incomingThrough: 0 },
      expected: "invalid",
    },
  ] as const;
  for (const entry of cases) {
    assert.equal(classifyRelayAck(entry.state), entry.expected);
  }
});
