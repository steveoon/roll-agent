import {
  RELAY_ERROR_CODES,
  RELAY_ERROR_RETRYABILITY,
  RELAY_INTERACTION_METHODS_V11,
  RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_METHOD_DISPOSITIONS,
  RELAY_REQUEST_METHOD_DISPOSITIONS_V11,
  RELAY_REQUEST_METHOD_VALUES,
  RELAY_REQUEST_METHOD_VALUES_V11,
  RELAY_REQUEST_REPLAY_DISPOSITIONS,
  RELAY_REQUEST_METHODS,
  RELAY_REQUEST_METHODS_V11,
  classifyRelayAck,
  classifyRelayRequestReplay,
  getRelayRequestMethodDisposition,
  getRelayRequestMethodDispositionForVersion,
  negotiateRelayProtocolVersion,
  parseRelayMessageForVersion,
  parseRelayRequestParams,
  parseRelayRequestParamsForVersion,
  parseRelayRequestResult,
  parseRelayRequestResultForVersion,
  relayMessageSchema,
  relayRuntimeRequestSchema,
  relayRuntimeRequestSchemaV11,
  type RelayAckDisposition,
  type RelayAckState,
  type RelayErrorCode,
  type RelayProtocolVersion,
  type RelayRequestMethod,
  type RelayRequestMethodForVersion,
  type RelayRequestMethodDisposition,
  type RelayRequestReplayClassification,
  type RelayReplayableRuntimeRequest,
  type RelayRuntimeRequest,
  type RelayRuntimeRequestV11,
} from "./index.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000501",
  thread: "00000000-0000-4000-8000-000000000502",
  turn: "00000000-0000-4000-8000-000000000503",
  approval: "00000000-0000-4000-8000-000000000504",
  request: "00000000-0000-4000-8000-000000000505",
  secondRequest: "00000000-0000-4000-8000-000000000509",
  device: "00000000-0000-4000-8000-000000000506",
  workspace: "00000000-0000-4000-8000-000000000507",
  secondWorkspace: "00000000-0000-4000-8000-000000000510",
  envelope: "00000000-0000-4000-8000-000000000508",
  interaction: "00000000-0000-4000-8000-000000000511",
  secondInteraction: "00000000-0000-4000-8000-000000000512",
} as const;

export interface RelayFrameConformanceCase {
  readonly id: string;
  readonly fixtureName: `${"valid" | "invalid"}-${string}.json`;
  readonly valid: boolean;
  readonly frame: unknown;
}

export const RELAY_FRAME_CONFORMANCE_CASES = [
  {
    id: "device-connect",
    fixtureName: "valid-device-connect.json",
    valid: true,
    frame: {
      type: "device.connect",
      protocolVersion: "1.0",
      deviceId: IDS.device,
      pairingToken: "pairing-token-with-sufficient-length",
    },
  },
  {
    id: "runtime-request",
    fixtureName: "valid-runtime-request.json",
    valid: true,
    frame: {
      type: "runtime.request",
      requestId: IDS.request,
      workspaceId: IDS.workspace,
      method: "thread.snapshot",
      params: { threadId: IDS.thread, limit: 100 },
    },
  },
  {
    id: "runtime-response",
    fixtureName: "valid-runtime-response.json",
    valid: true,
    frame: {
      type: "runtime.response",
      requestId: IDS.request,
      workspaceId: IDS.workspace,
      result: { accepted: true },
    },
  },
  {
    id: "runtime-event",
    fixtureName: "valid-runtime-event.json",
    valid: true,
    frame: {
      type: "runtime.event",
      workspaceId: IDS.workspace,
      relaySequence: 0,
      event: {
        protocolVersion: "1.0",
        runtimeInstanceId: IDS.runtime,
        sequence: 0,
        timestamp: "2026-07-30T00:00:00.000Z",
        threadId: IDS.thread,
        turnId: IDS.turn,
        event: { type: "turn.completed" },
      },
    },
  },
  {
    id: "runtime-ack",
    fixtureName: "valid-runtime-ack.json",
    valid: true,
    frame: {
      type: "runtime.ack",
      workspaceId: IDS.workspace,
      throughRelaySequence: 0,
    },
  },
  {
    id: "runtime-gap",
    fixtureName: "valid-runtime-gap.json",
    valid: true,
    frame: {
      type: "runtime.gap",
      workspaceId: IDS.workspace,
      fromRelaySequence: 0,
      throughRelaySequence: 2,
      recovery: "thread.snapshot",
    },
  },
  {
    id: "runtime-encrypted",
    fixtureName: "valid-runtime-encrypted.json",
    valid: true,
    frame: {
      type: "runtime.encrypted",
      workspaceId: IDS.workspace,
      envelopeId: IDS.envelope,
      payloadKind: "request",
      requestId: IDS.request,
      algorithm: "example-aead",
      nonce: "opaque-nonce",
      ciphertext: "opaque-ciphertext",
    },
  },
  {
    id: "unknown-version",
    fixtureName: "invalid-unknown-version.json",
    valid: false,
    frame: {
      type: "device.connect",
      protocolVersion: "9.9",
      deviceId: IDS.device,
      pairingToken: "pairing-token-with-sufficient-length",
    },
  },
  {
    id: "unknown-message",
    fixtureName: "invalid-unknown-message.json",
    valid: false,
    frame: {
      type: "runtime.unknown",
      workspaceId: IDS.workspace,
    },
  },
  {
    id: "unknown-method",
    fixtureName: "invalid-unknown-method.json",
    valid: false,
    frame: {
      type: "runtime.request",
      requestId: IDS.request,
      workspaceId: IDS.workspace,
      method: "runtime.futureMethod",
      params: {},
    },
  },
  {
    id: "invalid-id",
    fixtureName: "invalid-request-id.json",
    valid: false,
    frame: {
      type: "runtime.request",
      requestId: "not-a-uuid",
      workspaceId: IDS.workspace,
      method: "thread.list",
      params: {},
    },
  },
  {
    id: "extra-field",
    fixtureName: "invalid-extra-field.json",
    valid: false,
    frame: {
      type: "runtime.ack",
      workspaceId: IDS.workspace,
      throughRelaySequence: 0,
      unexpected: true,
    },
  },
  {
    id: "invalid-gap-recovery",
    fixtureName: "invalid-gap-recovery.json",
    valid: false,
    frame: {
      type: "runtime.gap",
      workspaceId: IDS.workspace,
      fromRelaySequence: 0,
      throughRelaySequence: 2,
      recovery: "event.replay",
    },
  },
  {
    id: "encrypted-metadata-leak",
    fixtureName: "invalid-encrypted-metadata-leak.json",
    valid: false,
    frame: {
      type: "runtime.encrypted",
      workspaceId: IDS.workspace,
      envelopeId: IDS.envelope,
      payloadKind: "request",
      requestId: IDS.request,
      algorithm: "example-aead",
      nonce: "opaque-nonce",
      ciphertext: "opaque-ciphertext",
      plaintext: { secret: "must-not-be-visible" },
    },
  },
] as const satisfies readonly RelayFrameConformanceCase[];

export const RELAY_FRAME_CONFORMANCE_CASES_V11 = [
  {
    id: "device-connect-v11",
    fixtureName: "valid-device-connect.json",
    valid: true,
    frame: {
      type: "device.connect",
      protocolVersion: "1.1",
      deviceId: IDS.device,
      pairingToken: "pairing-token-with-sufficient-length",
    },
  },
  {
    id: "runtime-request-v11",
    fixtureName: "valid-runtime-request.json",
    valid: true,
    frame: {
      type: "runtime.request",
      requestId: IDS.request,
      workspaceId: IDS.workspace,
      method: "thread.snapshot",
      params: { threadId: IDS.thread, limit: 100 },
    },
  },
  {
    id: "interaction-candidate-user-input",
    fixtureName: "valid-interaction-candidate-user-input.json",
    valid: true,
    frame: {
      type: "runtime.request",
      requestId: IDS.secondRequest,
      workspaceId: IDS.workspace,
      method: "interaction.candidate",
      params: {
        interactionId: IDS.interaction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        method: "userInput.request",
        candidate: {
          status: "submitted",
          values: [
            { id: "region", value: "north" },
            { id: "workspace", value: "target-workspace" },
          ],
        },
      },
    },
  },
  {
    id: "runtime-response-v11",
    fixtureName: "valid-runtime-response.json",
    valid: true,
    frame: {
      type: "runtime.response",
      requestId: IDS.request,
      workspaceId: IDS.workspace,
      result: { accepted: true },
    },
  },
  {
    id: "runtime-event-v11",
    fixtureName: "valid-runtime-event.json",
    valid: true,
    frame: {
      type: "runtime.event",
      workspaceId: IDS.workspace,
      relaySequence: 0,
      event: {
        protocolVersion: "1.1",
        runtimeInstanceId: IDS.runtime,
        sequence: 0,
        timestamp: "2026-08-04T00:00:00.000Z",
        threadId: IDS.thread,
        turnId: IDS.turn,
        event: { type: "turn.completed" },
      },
    },
  },
  {
    id: "runtime-event-runtime-n-minus-one",
    fixtureName: "valid-runtime-event-runtime-n-minus-one.json",
    valid: true,
    frame: {
      type: "runtime.event",
      workspaceId: IDS.workspace,
      relaySequence: 1,
      event: {
        protocolVersion: "1.0",
        runtimeInstanceId: IDS.runtime,
        sequence: 1,
        timestamp: "2026-08-04T00:00:01.000Z",
        threadId: IDS.thread,
        turnId: IDS.turn,
        event: { type: "turn.completed" },
      },
    },
  },
  {
    id: "runtime-ack-v11",
    fixtureName: "valid-runtime-ack.json",
    valid: true,
    frame: {
      type: "runtime.ack",
      workspaceId: IDS.workspace,
      throughRelaySequence: 1,
    },
  },
  {
    id: "runtime-gap-v11",
    fixtureName: "valid-runtime-gap.json",
    valid: true,
    frame: {
      type: "runtime.gap",
      workspaceId: IDS.workspace,
      fromRelaySequence: 0,
      throughRelaySequence: 2,
      recovery: "thread.snapshot",
    },
  },
  {
    id: "runtime-encrypted-interaction-v11",
    fixtureName: "valid-runtime-encrypted-interaction.json",
    valid: true,
    frame: {
      type: "runtime.encrypted",
      workspaceId: IDS.workspace,
      envelopeId: IDS.envelope,
      payloadKind: "interaction",
      relaySequence: 2,
      algorithm: "example-aead",
      nonce: "opaque-nonce",
      ciphertext: "opaque-ciphertext",
    },
  },
  {
    id: "interaction-request-approval",
    fixtureName: "valid-interaction-request-approval.json",
    valid: true,
    frame: {
      type: "interaction.request",
      workspaceId: IDS.workspace,
      relaySequence: 3,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      expiresAt: "2026-08-04T00:05:00.000Z",
      sensitivity: "normal",
      method: "approval.request",
      projection: {
        approvalId: IDS.approval,
        agentName: "workspace-agent",
        toolName: "deploy",
        explanation: "部署前需要确认。",
      },
    },
  },
  {
    id: "interaction-request-user-input",
    fixtureName: "valid-interaction-request-user-input.json",
    valid: true,
    frame: {
      type: "interaction.request",
      workspaceId: IDS.workspace,
      relaySequence: 4,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      expiresAt: "2026-08-04T00:05:00.000Z",
      sensitivity: "normal",
      method: "userInput.request",
      projection: {
        title: "部署配置",
        controls: [
          {
            id: "region",
            type: "choice",
            label: "部署区域",
            required: true,
            multiple: false,
            options: [
              { id: "north", label: "北区" },
              { id: "south", label: "南区" },
            ],
          },
          {
            id: "workspace",
            type: "text",
            label: "目标 Workspace",
            required: true,
            maxLength: 100,
          },
        ],
      },
    },
  },
  {
    id: "interaction-resolved",
    fixtureName: "valid-interaction-resolved.json",
    valid: true,
    frame: {
      type: "interaction.resolved",
      workspaceId: IDS.workspace,
      relaySequence: 5,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: "userInput.request",
    },
  },
  {
    id: "interaction-cancelled",
    fixtureName: "valid-interaction-cancelled.json",
    valid: true,
    frame: {
      type: "interaction.cancelled",
      workspaceId: IDS.workspace,
      relaySequence: 6,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: "approval.request",
    },
  },
  {
    id: "n-minus-one-device-connect-rejected",
    fixtureName: "invalid-n-minus-one-device-connect.json",
    valid: false,
    frame: {
      type: "device.connect",
      protocolVersion: "1.0",
      deviceId: IDS.device,
      pairingToken: "pairing-token-with-sufficient-length",
    },
  },
  {
    id: "legacy-approval-respond-rejected",
    fixtureName: "invalid-legacy-approval-respond.json",
    valid: false,
    frame: {
      type: "runtime.request",
      requestId: IDS.request,
      workspaceId: IDS.workspace,
      method: "approval.respond",
      params: {},
    },
  },
  {
    id: "legacy-approval-candidate-rejected",
    fixtureName: "invalid-legacy-approval-candidate.json",
    valid: false,
    frame: {
      type: "runtime.request",
      requestId: IDS.request,
      workspaceId: IDS.workspace,
      method: "approval.candidate",
      params: {},
    },
  },
  {
    id: "approval-projection-raw-input-leak",
    fixtureName: "invalid-approval-projection-raw-input-leak.json",
    valid: false,
    frame: {
      type: "interaction.request",
      workspaceId: IDS.workspace,
      relaySequence: 7,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      expiresAt: "2026-08-04T00:05:00.000Z",
      sensitivity: "normal",
      method: "approval.request",
      projection: {
        approvalId: IDS.approval,
        agentName: "workspace-agent",
        toolName: "deploy",
        input: { secret: "relay-security-sentinel" },
      },
    },
  },
  {
    id: "user-input-projection-secret-leak",
    fixtureName: "invalid-user-input-projection-secret-leak.json",
    valid: false,
    frame: {
      type: "interaction.request",
      workspaceId: IDS.workspace,
      relaySequence: 8,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      expiresAt: "2026-08-04T00:05:00.000Z",
      sensitivity: "normal",
      method: "userInput.request",
      projection: {
        controls: [
          {
            id: "workspace",
            type: "text",
            label: "目标 Workspace",
            required: true,
          },
        ],
        secret: "relay-security-sentinel",
      },
    },
  },
  {
    id: "non-normal-sensitivity-rejected",
    fixtureName: "invalid-non-normal-sensitivity.json",
    valid: false,
    frame: {
      type: "interaction.request",
      workspaceId: IDS.workspace,
      relaySequence: 9,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      expiresAt: "2026-08-04T00:05:00.000Z",
      sensitivity: "secret",
      method: "userInput.request",
      projection: {
        controls: [
          {
            id: "workspace",
            type: "text",
            label: "目标 Workspace",
            required: true,
          },
        ],
      },
    },
  },
  {
    id: "authentication-local-only",
    fixtureName: "invalid-authentication-local-only.json",
    valid: false,
    frame: {
      type: "interaction.request",
      workspaceId: IDS.workspace,
      relaySequence: 10,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      expiresAt: "2026-08-04T00:05:00.000Z",
      sensitivity: "normal",
      method: "authentication.request",
      projection: {},
    },
  },
  {
    id: "file-picker-local-only",
    fixtureName: "invalid-file-picker-local-only.json",
    valid: false,
    frame: {
      type: "interaction.request",
      workspaceId: IDS.workspace,
      relaySequence: 11,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      expiresAt: "2026-08-04T00:05:00.000Z",
      sensitivity: "normal",
      method: "filePicker.request",
      projection: {},
    },
  },
  {
    id: "interaction-resolved-result-leak",
    fixtureName: "invalid-interaction-resolved-result-leak.json",
    valid: false,
    frame: {
      type: "interaction.resolved",
      workspaceId: IDS.workspace,
      relaySequence: 12,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: "userInput.request",
      result: {
        status: "submitted",
        values: [{ id: "workspace", value: "relay-security-sentinel" }],
      },
    },
  },
  {
    id: "interaction-cancelled-reason-leak",
    fixtureName: "invalid-interaction-cancelled-reason-leak.json",
    valid: false,
    frame: {
      type: "interaction.cancelled",
      workspaceId: IDS.workspace,
      relaySequence: 13,
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: "approval.request",
      reason: "relay-security-sentinel",
    },
  },
  {
    id: "runtime-event-tool-input-leak",
    fixtureName: "invalid-runtime-event-tool-input-leak.json",
    valid: false,
    frame: {
      type: "runtime.event",
      workspaceId: IDS.workspace,
      relaySequence: 14,
      event: {
        protocolVersion: "1.1",
        runtimeInstanceId: IDS.runtime,
        sequence: 14,
        timestamp: "2026-08-04T00:00:14.000Z",
        threadId: IDS.thread,
        turnId: IDS.turn,
        event: {
          type: "tool.started",
          toolCallId: "tool-1",
          agentName: "workspace-agent",
          toolName: "deploy",
          input: { secret: "relay-security-sentinel" },
        },
      },
    },
  },
  {
    id: "runtime-event-tool-output-leak",
    fixtureName: "invalid-runtime-event-tool-output-leak.json",
    valid: false,
    frame: {
      type: "runtime.event",
      workspaceId: IDS.workspace,
      relaySequence: 15,
      event: {
        protocolVersion: "1.1",
        runtimeInstanceId: IDS.runtime,
        sequence: 15,
        timestamp: "2026-08-04T00:00:15.000Z",
        threadId: IDS.thread,
        turnId: IDS.turn,
        event: {
          type: "tool.output",
          toolCallId: "tool-1",
          agentName: "workspace-agent",
          toolName: "deploy",
          stream: "stdout",
          delta: "relay-security-sentinel",
        },
      },
    },
  },
] as const satisfies readonly RelayFrameConformanceCase[];

export interface RelayNegotiationConformanceCase {
  readonly id: string;
  readonly peerVersions: readonly string[];
  readonly expected: RelayProtocolVersion | undefined;
}

export const RELAY_NEGOTIATION_CONFORMANCE_CASES = [
  { id: "same-version", peerVersions: ["1.0"], expected: "1.0" },
  { id: "unknown-before-supported", peerVersions: ["9.9", "1.0"], expected: "1.0" },
  { id: "unknown-only", peerVersions: ["9.9"], expected: undefined },
] as const satisfies readonly RelayNegotiationConformanceCase[];

export const RELAY_NEGOTIATION_CONFORMANCE_CASES_V11 = [
  { id: "same-version-v11", peerVersions: ["1.1"], expected: "1.1" },
  {
    id: "latest-supported-version-preferred",
    peerVersions: ["1.0", "1.1"],
    expected: "1.1",
  },
  { id: "n-minus-one-fallback", peerVersions: ["1.0"], expected: "1.0" },
  {
    id: "unknown-before-supported-v11",
    peerVersions: ["9.9", "1.1"],
    expected: "1.1",
  },
  { id: "unknown-only-v11", peerVersions: ["9.9"], expected: undefined },
] as const satisfies readonly RelayNegotiationConformanceCase[];

export interface RelayMethodRegistryConformanceCase {
  readonly id: string;
  readonly value: string;
  readonly expected: RelayRequestMethodDisposition | undefined;
}

export const RELAY_METHOD_REGISTRY_CONFORMANCE_CASES: readonly RelayMethodRegistryConformanceCase[] =
  [
    ...RELAY_REQUEST_METHOD_VALUES.map((value) => ({
      id: `method-disposition-${value}`,
      value,
      expected: RELAY_REQUEST_METHOD_DISPOSITIONS[value],
    })),
    {
      id: "unknown-method-not-recognized",
      value: "runtime.futureMethod",
      expected: undefined,
    },
  ];

export const RELAY_METHOD_REGISTRY_CONFORMANCE_CASES_V11: readonly RelayMethodRegistryConformanceCase[] =
  [
    ...RELAY_REQUEST_METHOD_VALUES_V11.map((value) => ({
      id: `method-disposition-v11-${value}`,
      value,
      expected: RELAY_REQUEST_METHOD_DISPOSITIONS_V11[value],
    })),
    {
      id: "legacy-approval-respond-not-recognized-v11",
      value: RELAY_REQUEST_METHODS.approvalRespond,
      expected: undefined,
    },
    {
      id: "legacy-approval-candidate-not-recognized-v11",
      value: RELAY_REQUEST_METHODS.approvalCandidate,
      expected: undefined,
    },
    {
      id: "unknown-method-not-recognized-v11",
      value: "runtime.futureMethod",
      expected: undefined,
    },
  ];

export interface RelayMethodConformanceCase {
  readonly id: string;
  readonly method: RelayRequestMethod;
  readonly kind: "params" | "result";
  readonly valid: boolean;
  readonly value: unknown;
}

export const RELAY_METHOD_CONFORMANCE_CASES = [
  {
    id: "approval-candidate-params",
    method: RELAY_REQUEST_METHODS.approvalCandidate,
    kind: "params",
    valid: true,
    value: {
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "approve",
    },
  },
  {
    id: "approval-candidate-empty-reason",
    method: RELAY_REQUEST_METHODS.approvalCandidate,
    kind: "params",
    valid: false,
    value: {
      threadId: IDS.thread,
      turnId: IDS.turn,
      approvalId: IDS.approval,
      decision: "reject",
      reason: "",
    },
  },
  {
    id: "approval-candidate-result",
    method: RELAY_REQUEST_METHODS.approvalCandidate,
    kind: "result",
    valid: true,
    value: { accepted: true },
  },
] as const satisfies readonly RelayMethodConformanceCase[];

export interface RelayMethodConformanceCaseV11 {
  readonly id: string;
  readonly method: RelayRequestMethodForVersion<"1.1">;
  readonly kind: "params" | "result";
  readonly valid: boolean;
  readonly value: unknown;
}

export const RELAY_METHOD_CONFORMANCE_CASES_V11 = [
  {
    id: "interaction-candidate-approval-params",
    method: RELAY_REQUEST_METHODS_V11.interactionCandidate,
    kind: "params",
    valid: true,
    value: {
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
      candidate: { decision: "approve" },
    },
  },
  {
    id: "interaction-candidate-user-input-params",
    method: RELAY_REQUEST_METHODS_V11.interactionCandidate,
    kind: "params",
    valid: true,
    value: {
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
      candidate: {
        status: "submitted",
        values: [
          { id: "region", value: ["north"] },
          { id: "workspace", value: "production" },
        ],
      },
    },
  },
  {
    id: "interaction-candidate-method-result-mismatch",
    method: RELAY_REQUEST_METHODS_V11.interactionCandidate,
    kind: "params",
    valid: false,
    value: {
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
      candidate: { status: "submitted", values: [] },
    },
  },
  {
    id: "interaction-candidate-missing-identity",
    method: RELAY_REQUEST_METHODS_V11.interactionCandidate,
    kind: "params",
    valid: false,
    value: {
      method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
      candidate: { status: "cancelled" },
    },
  },
  {
    id: "interaction-candidate-result",
    method: RELAY_REQUEST_METHODS_V11.interactionCandidate,
    kind: "result",
    valid: true,
    value: { accepted: true },
  },
  {
    id: "interaction-candidate-result-must-be-accepted",
    method: RELAY_REQUEST_METHODS_V11.interactionCandidate,
    kind: "result",
    valid: false,
    value: { accepted: false },
  },
] as const satisfies readonly RelayMethodConformanceCaseV11[];

const replayRequest = relayRuntimeRequestSchema.parse(
  RELAY_FRAME_CONFORMANCE_CASES.find((entry) => entry.id === "runtime-request")?.frame,
);

export interface RelayReplayConformanceCase<
  TRequest extends RelayReplayableRuntimeRequest = RelayRuntimeRequest,
> {
  readonly id: string;
  readonly existing: TRequest;
  readonly candidate: TRequest;
  readonly expected: RelayRequestReplayClassification;
}

export const RELAY_REPLAY_CONFORMANCE_CASES: readonly RelayReplayConformanceCase[] = [
  {
    id: "same-request-different-key-order",
    existing: replayRequest,
    candidate: relayRuntimeRequestSchema.parse({
      ...replayRequest,
      params: { limit: 100, threadId: IDS.thread },
    }),
    expected: {
      disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.replay,
    },
  },
  {
    id: "same-id-different-payload",
    existing: replayRequest,
    candidate: relayRuntimeRequestSchema.parse({
      ...replayRequest,
      params: { threadId: IDS.thread, limit: 10 },
    }),
    expected: {
      disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.conflict,
      errorCode: RELAY_ERROR_CODES.requestIdConflict,
    },
  },
  {
    id: "same-id-different-method",
    existing: replayRequest,
    candidate: relayRuntimeRequestSchema.parse({
      ...replayRequest,
      method: RELAY_REQUEST_METHODS.threadOpen,
    }),
    expected: {
      disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.conflict,
      errorCode: RELAY_ERROR_CODES.requestIdConflict,
    },
  },
  {
    id: "different-request-id",
    existing: replayRequest,
    candidate: relayRuntimeRequestSchema.parse({
      ...replayRequest,
      requestId: IDS.secondRequest,
    }),
    expected: {
      disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.new,
    },
  },
  {
    id: "different-workspace-id",
    existing: replayRequest,
    candidate: relayRuntimeRequestSchema.parse({
      ...replayRequest,
      workspaceId: IDS.secondWorkspace,
    }),
    expected: {
      disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.new,
    },
  },
];

const replayRequestV11 = relayRuntimeRequestSchemaV11.parse(
  RELAY_FRAME_CONFORMANCE_CASES_V11.find((entry) => entry.id === "interaction-candidate-user-input")
    ?.frame,
);

export const RELAY_REPLAY_CONFORMANCE_CASES_V11: readonly RelayReplayConformanceCase<RelayRuntimeRequestV11>[] =
  [
    {
      id: "interaction-candidate-duplicate",
      existing: replayRequestV11,
      candidate: relayRuntimeRequestSchemaV11.parse({
        ...replayRequestV11,
        params: {
          turnId: IDS.turn,
          interactionId: IDS.interaction,
          candidate: {
            values: [
              { value: "north", id: "region" },
              { value: "target-workspace", id: "workspace" },
            ],
            status: "submitted",
          },
          method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
          threadId: IDS.thread,
        },
      }),
      expected: { disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.replay },
    },
    {
      id: "interaction-candidate-conflict",
      existing: replayRequestV11,
      candidate: relayRuntimeRequestSchemaV11.parse({
        ...replayRequestV11,
        params: {
          interactionId: IDS.secondInteraction,
          threadId: IDS.thread,
          turnId: IDS.turn,
          method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
          candidate: {
            status: "submitted",
            values: [
              { id: "region", value: "north" },
              { id: "workspace", value: "target-workspace" },
            ],
          },
        },
      }),
      expected: {
        disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.conflict,
        errorCode: RELAY_ERROR_CODES.requestIdConflict,
      },
    },
    {
      id: "interaction-candidate-different-request-id",
      existing: replayRequestV11,
      candidate: relayRuntimeRequestSchemaV11.parse({
        ...replayRequestV11,
        requestId: IDS.request,
      }),
      expected: { disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.new },
    },
    {
      id: "interaction-candidate-different-workspace",
      existing: replayRequestV11,
      candidate: relayRuntimeRequestSchemaV11.parse({
        ...replayRequestV11,
        workspaceId: IDS.secondWorkspace,
      }),
      expected: { disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.new },
    },
  ];

export interface RelayAckConformanceCase extends RelayAckState {
  readonly id: string;
  readonly expected: RelayAckDisposition;
}

export const RELAY_ACK_CONFORMANCE_CASES = [
  {
    id: "initial-advance",
    acknowledgedThrough: -1,
    advertisedThrough: 0,
    incomingThrough: 0,
    expected: "advance",
  },
  {
    id: "advance-contiguous-prefix",
    acknowledgedThrough: 0,
    advertisedThrough: 2,
    incomingThrough: 2,
    expected: "advance",
  },
  {
    id: "equal-duplicate-ack",
    acknowledgedThrough: 2,
    advertisedThrough: 2,
    incomingThrough: 2,
    expected: "duplicate",
  },
  {
    id: "stale-duplicate-ack",
    acknowledgedThrough: 2,
    advertisedThrough: 2,
    incomingThrough: 1,
    expected: "duplicate",
  },
  {
    id: "ack-beyond-advertised",
    acknowledgedThrough: 0,
    advertisedThrough: 1,
    incomingThrough: 2,
    expected: "invalid",
  },
  {
    id: "fractional-ack",
    acknowledgedThrough: 0,
    advertisedThrough: 1,
    incomingThrough: 0.5,
    expected: "invalid",
  },
  {
    id: "ack-below-sentinel",
    acknowledgedThrough: -2,
    advertisedThrough: 0,
    incomingThrough: 0,
    expected: "invalid",
  },
] as const satisfies readonly RelayAckConformanceCase[];

export const RELAY_ENCRYPTED_VISIBLE_METADATA_FIELDS = [
  "type",
  "workspaceId",
  "envelopeId",
  "payloadKind",
  "requestId",
  "relaySequence",
  "algorithm",
  "nonce",
  "ciphertext",
] as const;

export interface RelayErrorConformanceCase {
  readonly id: string;
  readonly code: RelayErrorCode;
  readonly retryable: boolean;
}

export const RELAY_ERROR_CONFORMANCE_CASES = Object.values(RELAY_ERROR_CODES).map((code) => ({
  id: `error-retryability-${code}`,
  code,
  retryable: RELAY_ERROR_RETRYABILITY[code],
})) satisfies readonly RelayErrorConformanceCase[];

export interface RelayProtocolConformanceAdapter {
  validateFrame(value: unknown): boolean;
  negotiate(peerVersions: readonly string[]): RelayProtocolVersion | undefined;
  getRequestMethodDisposition(value: string): string | undefined;
  validateMethodValue(
    method: RelayRequestMethod,
    kind: "params" | "result",
    value: unknown,
  ): boolean;
  classifyReplay(
    existing: RelayRuntimeRequest,
    candidate: RelayRuntimeRequest,
  ): RelayReplayConformanceObservation;
  classifyAck(state: RelayAckState): RelayAckDisposition;
  getErrorRetryability(code: RelayErrorCode): boolean;
}

export interface RelayProtocolConformanceAdapterV11 {
  validateFrame(value: unknown): boolean;
  negotiate(peerVersions: readonly string[]): RelayProtocolVersion | undefined;
  getRequestMethodDisposition(value: string): string | undefined;
  validateMethodValue(
    method: RelayRequestMethodForVersion<"1.1">,
    kind: "params" | "result",
    value: unknown,
  ): boolean;
  classifyReplay(
    existing: RelayRuntimeRequestV11,
    candidate: RelayRuntimeRequestV11,
  ): RelayReplayConformanceObservation;
  classifyAck(state: RelayAckState): RelayAckDisposition;
  getErrorRetryability(code: RelayErrorCode): boolean;
}

export interface RelayReplayConformanceObservation {
  readonly disposition: string;
  readonly errorCode?: string;
}

export const runtimeRelayProtocolConformanceAdapter: RelayProtocolConformanceAdapter = {
  validateFrame: (value) => relayMessageSchema.safeParse(value).success,
  negotiate: (peerVersions) =>
    peerVersions.includes(RELAY_PROTOCOL_VERSION) ? RELAY_PROTOCOL_VERSION : undefined,
  getRequestMethodDisposition: getRelayRequestMethodDisposition,
  validateMethodValue(method, kind, value) {
    try {
      if (kind === "params") {
        parseRelayRequestParams(method, value);
      } else {
        parseRelayRequestResult(method, value);
      }
      return true;
    } catch {
      return false;
    }
  },
  classifyReplay: classifyRelayRequestReplay,
  classifyAck: classifyRelayAck,
  getErrorRetryability: (code) => RELAY_ERROR_RETRYABILITY[code],
};

export const runtimeRelayProtocolConformanceAdapterV10 = runtimeRelayProtocolConformanceAdapter;

export const runtimeRelayProtocolConformanceAdapterV11: RelayProtocolConformanceAdapterV11 = {
  validateFrame(value) {
    try {
      parseRelayMessageForVersion("1.1", value);
      return true;
    } catch {
      return false;
    }
  },
  negotiate: negotiateRelayProtocolVersion,
  getRequestMethodDisposition: (value) => getRelayRequestMethodDispositionForVersion("1.1", value),
  validateMethodValue(method, kind, value) {
    try {
      if (kind === "params") {
        parseRelayRequestParamsForVersion("1.1", method, value);
      } else {
        parseRelayRequestResultForVersion("1.1", method, value);
      }
      return true;
    } catch {
      return false;
    }
  },
  classifyReplay: classifyRelayRequestReplay,
  classifyAck: classifyRelayAck,
  getErrorRetryability: (code) => RELAY_ERROR_RETRYABILITY[code],
};

export interface RelayProtocolConformanceFailure {
  readonly caseId: string;
  readonly expected: string;
  readonly actual: string;
}

export interface RelayProtocolConformanceResult {
  readonly protocolVersion: typeof RELAY_PROTOCOL_VERSION;
  readonly passed: boolean;
  readonly failures: readonly RelayProtocolConformanceFailure[];
}

export interface RelayProtocolConformanceResultForVersion<TVersion extends RelayProtocolVersion> {
  readonly protocolVersion: TVersion;
  readonly passed: boolean;
  readonly failures: readonly RelayProtocolConformanceFailure[];
}

export function runRelayProtocolConformance(
  adapter: RelayProtocolConformanceAdapter,
): RelayProtocolConformanceResult {
  return runRelayProtocolConformanceCases(
    RELAY_PROTOCOL_VERSION,
    adapter,
    RELAY_FRAME_CONFORMANCE_CASES,
    RELAY_NEGOTIATION_CONFORMANCE_CASES,
    RELAY_METHOD_REGISTRY_CONFORMANCE_CASES,
    RELAY_METHOD_CONFORMANCE_CASES,
    RELAY_REPLAY_CONFORMANCE_CASES,
  );
}

export function runRelayProtocolConformanceForVersion(
  ...args: readonly [version: "1.0", adapter: RelayProtocolConformanceAdapter]
): RelayProtocolConformanceResultForVersion<"1.0">;
export function runRelayProtocolConformanceForVersion(
  ...args: readonly [version: "1.1", adapter: RelayProtocolConformanceAdapterV11]
): RelayProtocolConformanceResultForVersion<"1.1">;
export function runRelayProtocolConformanceForVersion(
  ...args:
    | readonly [version: "1.0", adapter: RelayProtocolConformanceAdapter]
    | readonly [version: "1.1", adapter: RelayProtocolConformanceAdapterV11]
): RelayProtocolConformanceResultForVersion<RelayProtocolVersion> {
  if (args[0] === "1.0") {
    return runRelayProtocolConformance(args[1]);
  }
  return runRelayProtocolConformanceCases(
    args[0],
    args[1],
    RELAY_FRAME_CONFORMANCE_CASES_V11,
    RELAY_NEGOTIATION_CONFORMANCE_CASES_V11,
    RELAY_METHOD_REGISTRY_CONFORMANCE_CASES_V11,
    RELAY_METHOD_CONFORMANCE_CASES_V11,
    RELAY_REPLAY_CONFORMANCE_CASES_V11,
  );
}

interface RelayProtocolConformanceCaseSet<
  TMethod extends string,
  TRequest extends RelayReplayableRuntimeRequest,
> {
  readonly frames: readonly RelayFrameConformanceCase[];
  readonly negotiations: readonly RelayNegotiationConformanceCase[];
  readonly methodRegistry: readonly RelayMethodRegistryConformanceCase[];
  readonly methods: readonly {
    readonly id: string;
    readonly method: TMethod;
    readonly kind: "params" | "result";
    readonly valid: boolean;
    readonly value: unknown;
  }[];
  readonly replay: readonly RelayReplayConformanceCase<TRequest>[];
}

interface RelayProtocolConformanceAdapterShape<
  TMethod extends string,
  TRequest extends RelayReplayableRuntimeRequest,
> {
  validateFrame(value: unknown): boolean;
  negotiate(peerVersions: readonly string[]): RelayProtocolVersion | undefined;
  getRequestMethodDisposition(value: string): string | undefined;
  validateMethodValue(method: TMethod, kind: "params" | "result", value: unknown): boolean;
  classifyReplay(existing: TRequest, candidate: TRequest): RelayReplayConformanceObservation;
  classifyAck(state: RelayAckState): RelayAckDisposition;
  getErrorRetryability(code: RelayErrorCode): boolean;
}

function runRelayProtocolConformanceCases<
  TVersion extends RelayProtocolVersion,
  TMethod extends string,
  TRequest extends RelayReplayableRuntimeRequest,
>(
  protocolVersion: TVersion,
  adapter: RelayProtocolConformanceAdapterShape<TMethod, TRequest>,
  frames: RelayProtocolConformanceCaseSet<TMethod, TRequest>["frames"],
  negotiations: RelayProtocolConformanceCaseSet<TMethod, TRequest>["negotiations"],
  methodRegistry: RelayProtocolConformanceCaseSet<TMethod, TRequest>["methodRegistry"],
  methods: RelayProtocolConformanceCaseSet<TMethod, TRequest>["methods"],
  replay: RelayProtocolConformanceCaseSet<TMethod, TRequest>["replay"],
): RelayProtocolConformanceResultForVersion<TVersion> {
  const failures: RelayProtocolConformanceFailure[] = [];
  for (const entry of frames) {
    recordFailure(failures, entry.id, entry.valid, adapter.validateFrame(entry.frame));
  }
  for (const entry of negotiations) {
    recordFailure(
      failures,
      entry.id,
      entry.expected ?? "unsupported",
      adapter.negotiate(entry.peerVersions) ?? "unsupported",
    );
  }
  for (const entry of methodRegistry) {
    recordFailure(
      failures,
      entry.id,
      entry.expected ?? "unrecognized",
      adapter.getRequestMethodDisposition(entry.value) ?? "unrecognized",
    );
  }
  for (const entry of methods) {
    recordFailure(
      failures,
      entry.id,
      entry.valid,
      adapter.validateMethodValue(entry.method, entry.kind, entry.value),
    );
  }
  for (const entry of replay) {
    const actual = adapter.classifyReplay(entry.existing, entry.candidate);
    recordFailure(
      failures,
      `${entry.id}-disposition`,
      entry.expected.disposition,
      actual.disposition,
    );
    recordFailure(
      failures,
      `${entry.id}-error-code`,
      "errorCode" in entry.expected ? entry.expected.errorCode : "none",
      actual.errorCode ?? "none",
    );
  }
  for (const entry of RELAY_ACK_CONFORMANCE_CASES) {
    recordFailure(failures, entry.id, entry.expected, adapter.classifyAck(entry));
  }
  for (const entry of RELAY_ERROR_CONFORMANCE_CASES) {
    recordFailure(failures, entry.id, entry.retryable, adapter.getErrorRetryability(entry.code));
  }
  return {
    protocolVersion,
    passed: failures.length === 0,
    failures,
  };
}

function recordFailure(
  failures: RelayProtocolConformanceFailure[],
  caseId: string,
  expected: string | boolean,
  actual: string | boolean,
): void {
  if (expected === actual) {
    return;
  }
  failures.push({
    caseId,
    expected: String(expected),
    actual: String(actual),
  });
}
