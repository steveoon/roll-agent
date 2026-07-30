import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELAY_MESSAGE_TYPE_VALUES,
  RELAY_ERROR_CODES,
  RELAY_ERROR_RETRYABILITY,
  RELAY_MUTATION_REQUEST_METHODS,
  RELAY_PROTOCOL_REGISTRY,
  RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_REPLAY_DISPOSITIONS,
  RELAY_REQUEST_METHODS,
  RELAY_REQUEST_METHOD_DISPOSITIONS,
  RELAY_REQUEST_METHOD_VALUES,
  SUPPORTED_RELAY_PROTOCOL_VERSIONS,
  classifyRelayAck,
  classifyRelayRequestReplay,
  getRelayRequestMethodDisposition,
  getRelayProtocolRegistry,
  getRelayErrorRetryability,
  isRelayMutationRequestMethod,
  negotiateRelayProtocolVersion,
  parseRelayRequestParams,
  relayDeviceConnectSchema,
  relayRuntimeRequestSchema,
} from "./index.ts";

const IDS = {
  thread: "00000000-0000-4000-8000-000000000601",
  turn: "00000000-0000-4000-8000-000000000602",
  approval: "00000000-0000-4000-8000-000000000603",
  request: "00000000-0000-4000-8000-000000000604",
  secondRequest: "00000000-0000-4000-8000-000000000607",
  device: "00000000-0000-4000-8000-000000000605",
  workspace: "00000000-0000-4000-8000-000000000606",
  secondWorkspace: "00000000-0000-4000-8000-000000000608",
} as const;

test("Relay Protocol v1.0 freezes message and request registries", () => {
  assert.equal(RELAY_PROTOCOL_VERSION, "1.0");
  assert.deepEqual(SUPPORTED_RELAY_PROTOCOL_VERSIONS, ["1.0"]);
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
