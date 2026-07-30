import {
  RELAY_ERROR_CODES,
  RELAY_ERROR_RETRYABILITY,
  RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_METHOD_DISPOSITIONS,
  RELAY_REQUEST_METHOD_VALUES,
  RELAY_REQUEST_REPLAY_DISPOSITIONS,
  RELAY_REQUEST_METHODS,
  classifyRelayAck,
  classifyRelayRequestReplay,
  getRelayRequestMethodDisposition,
  negotiateRelayProtocolVersion,
  parseRelayRequestParams,
  parseRelayRequestResult,
  relayMessageSchema,
  relayRuntimeRequestSchema,
  type RelayAckDisposition,
  type RelayAckState,
  type RelayErrorCode,
  type RelayProtocolVersion,
  type RelayRequestMethod,
  type RelayRequestMethodDisposition,
  type RelayRequestReplayClassification,
  type RelayRuntimeRequest,
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

const replayRequest = relayRuntimeRequestSchema.parse(
  RELAY_FRAME_CONFORMANCE_CASES.find((entry) => entry.id === "runtime-request")?.frame,
);

export interface RelayReplayConformanceCase {
  readonly id: string;
  readonly existing: RelayRuntimeRequest;
  readonly candidate: RelayRuntimeRequest;
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

export interface RelayReplayConformanceObservation {
  readonly disposition: string;
  readonly errorCode?: string;
}

export const runtimeRelayProtocolConformanceAdapter: RelayProtocolConformanceAdapter = {
  validateFrame: (value) => relayMessageSchema.safeParse(value).success,
  negotiate: negotiateRelayProtocolVersion,
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

export function runRelayProtocolConformance(
  adapter: RelayProtocolConformanceAdapter,
): RelayProtocolConformanceResult {
  const failures: RelayProtocolConformanceFailure[] = [];
  for (const entry of RELAY_FRAME_CONFORMANCE_CASES) {
    recordFailure(failures, entry.id, entry.valid, adapter.validateFrame(entry.frame));
  }
  for (const entry of RELAY_NEGOTIATION_CONFORMANCE_CASES) {
    recordFailure(
      failures,
      entry.id,
      entry.expected ?? "unsupported",
      adapter.negotiate(entry.peerVersions) ?? "unsupported",
    );
  }
  for (const entry of RELAY_METHOD_REGISTRY_CONFORMANCE_CASES) {
    recordFailure(
      failures,
      entry.id,
      entry.expected ?? "unrecognized",
      adapter.getRequestMethodDisposition(entry.value) ?? "unrecognized",
    );
  }
  for (const entry of RELAY_METHOD_CONFORMANCE_CASES) {
    recordFailure(
      failures,
      entry.id,
      entry.valid,
      adapter.validateMethodValue(entry.method, entry.kind, entry.value),
    );
  }
  for (const entry of RELAY_REPLAY_CONFORMANCE_CASES) {
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
    protocolVersion: RELAY_PROTOCOL_VERSION,
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
