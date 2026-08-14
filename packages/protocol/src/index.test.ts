import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  APPROVAL_EXPLANATION_MAX_CHARS,
  APPROVAL_EXPLANATION_PREVIEW_KEY,
  CLIENT_CAPABILITY_METHOD_MAX_COUNT,
  CLIENT_CAPABILITY_METHOD_MAX_CHARS,
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_ERROR_CODES,
  RUNTIME_ERROR_CODES_V12,
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_CAPABILITIES,
  RUNTIME_PROTOCOL_REGISTRY,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  RUNTIME_SERVER_REQUEST_METHODS,
  RUNTIME_SERVER_REQUEST_METHOD_VALUES,
  RUNTIME_SERVER_REQUEST_METHOD_VALUES_V11,
  RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES,
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES,
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORDS,
  RUNTIME_V13_MIN_CLIENT_FRAME_BYTES,
  RUNTIME_V13_RECOVERY_SNAPSHOT_METADATA_MAX_CHARS,
  RUNTIME_V13_RECOVERY_SNAPSHOT_TIMESTAMP_MAX_CHARS,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V11,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V12,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V13,
  USER_INPUT_CHOICE_OPTION_MAX_COUNT,
  USER_INPUT_CONTROL_ID_MAX_CHARS,
  USER_INPUT_CONTROL_MAX_COUNT,
  USER_INPUT_DESCRIPTION_MAX_CHARS,
  USER_INPUT_LABEL_MAX_CHARS,
  USER_INPUT_TEXT_MAX_CHARS,
  activeTurnV11Schema,
  activeTurnV12Schema,
  approvalIdSchema,
  approvalRequestParamsV12Schema,
  clientCapabilitiesSetParamsSchema,
  clientCapabilitiesSetResultSchema,
  compareRuntimeEventCursors,
  getApprovalExplanation,
  getRuntimeProtocolCapabilities,
  getRuntimeProtocolRegistry,
  initializeParamsSchema,
  initializeResultSchema,
  interactionIdSchema,
  isLatestRuntimeServerRequestMethod,
  isRuntimeMethodAvailable,
  isRuntimeServerRequestMethod,
  isRuntimeServerRequestMethodAvailable,
  isRuntimeServerRequestMethodRequired,
  normalizeUserInputResult,
  operationGetResultSchema,
  parseRuntimeMethodResult,
  parseRuntimeMethodResultForVersion,
  parseRuntimeServerRequestParams,
  parseRuntimeMethodParamsForVersion,
  parseRuntimeProtocolErrorDataForVersion,
  parseRuntimeServerRequestCancelParamsForVersion,
  parseRuntimeServerRequestParamsForVersion,
  parseRuntimeServerRequestResult,
  parseRuntimeServerRequestResultForVersion,
  pendingApprovalSchema,
  pendingInteractionProjectionSchema,
  pendingUserInputInteractionProjectionSchema,
  projectClientCapabilitiesSetResult,
  projectRuntimeEventEnvelopeForVersion,
  projectRuntimeServerRequestCancelParams,
  projectRuntimeServerRequestParams,
  projectThreadSnapshotForVersion,
  runtimeEventEnvelopeSchema,
  runtimeEventEnvelopeV11Schema,
  runtimeEventEnvelopeV13Schema,
  runtimeEventEnvelopeV14Schema,
  runtimeEventCursorDistance,
  runtimeEventCursorSchema,
  runtimeEventIdSchema,
  runtimeEventsResumeParamsSchema,
  runtimeEventsResumeResultSchema,
  runtimeMethodSchemas,
  runtimeProtocolErrorDataSchema,
  runtimeServerRequestCancelParamsSchema,
  runtimeServerRequestCancelParamsV12Schema,
  runtimeServerRequestSchemas,
  threadSnapshotSchema,
  threadSnapshotParamsV12Schema,
  threadSnapshotParamsV13Schema,
  threadSnapshotV12Schema,
  threadSnapshotV11Schema,
  userInputFormSchema,
  userInputRequestParamsV12Schema,
  userInputResultSchema,
  type ApprovalId,
  type InteractionId,
  type LatestRuntimeServerRequestInput,
  type LatestRuntimeServerRequestParams,
  type LatestRuntimeServerRequestResult,
  type RuntimeProtocolVersion,
  type RuntimeEventCursor,
  type RuntimeEventId,
  type RuntimeServerRequestCancelParamsForVersion,
  type RuntimeServerRequestHandlers,
  type RuntimeServerRequestInputForSupportedVersions,
  type RuntimeServerRequestParamsForVersion,
  type RuntimeServerRequestParamsForSupportedVersions,
  type RuntimeServerRequestResultForSupportedVersions,
  type UserInputForm,
  type UserInputRequestParamsV12,
  type UserInputResult,
} from "./index.ts";

test("Runtime Protocol 1.3 frame and replay budgets cover the durable retention window", () => {
  assert.equal(RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES, 16 * 1_024 * 1_024);
  assert.equal(RUNTIME_V13_MAX_DURABLE_EVENT_RECORDS, 10_000);
  assert.equal(RUNTIME_V13_MIN_CLIENT_FRAME_BYTES, 17 * 1_024 * 1_024);
  assert.equal(RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES, 32 * 1_024 * 1_024);

  const nearLimitEvent = {
    jsonrpc: "2.0",
    method: RUNTIME_EVENT_NOTIFICATION,
    params: runtimeEventEnvelopeV13Schema.parse({
      protocolVersion: "1.3",
      runtimeInstanceId: "00000000-0000-4000-8000-000000000001",
      sequence: Number.MAX_SAFE_INTEGER,
      timestamp: "2026-08-04T12:00:00.000Z",
      threadId: "00000000-0000-4000-8000-000000000002",
      turnId: "00000000-0000-4000-8000-000000000003",
      durability: "durable",
      eventId: "00000000-0000-4000-8000-000000000004",
      cursor:
        "rte1:00000000-0000-4000-8000-000000000005:9007199254740991:00000000-0000-4000-8000-000000000004",
      event: {
        type: "message.completed",
        streamId: "00000000-0000-4000-8000-000000000006",
        text: "x".repeat(RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES - 4_096),
      },
    }),
  } as const;
  assert.ok(
    Buffer.byteLength(JSON.stringify(nearLimitEvent), "utf8") < RUNTIME_V13_MIN_CLIENT_FRAME_BYTES,
  );
});

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000001",
  thread: "00000000-0000-4000-8000-000000000002",
  turn: "00000000-0000-4000-8000-000000000003",
  stream: "00000000-0000-4000-8000-000000000004",
  approval: "00000000-0000-4000-8000-000000000005",
  interaction: "00000000-0000-4000-8000-000000000006",
  event: "00000000-0000-4000-8000-000000000007",
  event2: "00000000-0000-4000-8000-000000000008",
  eventLog: "00000000-0000-4000-8000-000000000009",
} as const;

const CURSORS = {
  first: `rte1:${IDS.eventLog}:0:${IDS.event}`,
  second: `rte1:${IDS.eventLog}:1:${IDS.event2}`,
} as const;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/v1/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function fixtureV12(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/v1.2/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function fixtureV13(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/v1.3/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function parseNegotiatedCancel(
  version: RuntimeProtocolVersion,
  value: unknown,
): RuntimeServerRequestCancelParamsForVersion<RuntimeProtocolVersion> {
  return parseRuntimeServerRequestCancelParamsForVersion(version, value);
}

function parseNegotiatedApproval(
  version: Exclude<RuntimeProtocolVersion, "1.0">,
  value: unknown,
): RuntimeServerRequestParamsForVersion<
  Exclude<RuntimeProtocolVersion, "1.0">,
  typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
> {
  return parseRuntimeServerRequestParamsForVersion(
    version,
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    value,
  );
}

function userInputRequestParams(controls: UserInputForm["controls"]): UserInputRequestParamsV12 {
  return userInputRequestParamsV12Schema.parse({
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: "2026-07-29T12:10:00.000Z",
    sensitivity: "normal",
    title: "部署配置",
    description: "请确认本次部署所需的普通配置，不要填写密码或 token。",
    controls,
  });
}

test("initialize advertises v1.4 first without changing the strict request shape", () => {
  const input = {
    protocolVersions: [...SUPPORTED_RUNTIME_PROTOCOL_VERSIONS],
    client: { name: "fixture-client", version: "1.0.0" },
  } as const;
  const parsed = initializeParamsSchema.parse(input);
  assert.equal(RUNTIME_PROTOCOL_VERSION, "1.4");
  assert.deepEqual(parsed.protocolVersions, ["1.4", "1.3", "1.2", "1.1", "1.0"]);
  assert.deepEqual(SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V13, ["1.3", "1.2", "1.1", "1.0"]);
  assert.deepEqual(SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V12, ["1.2", "1.1", "1.0"]);
  assert.deepEqual(SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V11, ["1.1", "1.0"]);
  for (const version of SUPPORTED_RUNTIME_PROTOCOL_VERSIONS) {
    assert.deepEqual(
      parseRuntimeMethodParamsForVersion(version, RUNTIME_METHODS.initialize, input),
      parsed,
    );
    assert.throws(() =>
      parseRuntimeMethodParamsForVersion(version, RUNTIME_METHODS.initialize, {
        ...parsed,
        serverRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
      }),
    );
  }
  assert.equal(
    initializeResultSchema.parse({
      protocolVersion: "1.0",
      runtimeInstanceId: IDS.runtime,
      server: {
        name: "fixture-runtime",
        version: "1.0.0",
        runtimeVersion: "1.0.0",
      },
      features: [],
      limits: {
        maxFrameBytes: 1,
        maxPageSize: 1,
        eventReplay: false,
        idempotencyCacheEntries: 1,
      },
    }).protocolVersion,
    "1.0",
  );
  const latestResult = initializeResultSchema.parse({
    protocolVersion: "1.3",
    runtimeInstanceId: IDS.runtime,
    server: {
      name: "fixture-runtime",
      version: "1.0.0",
      runtimeVersion: "1.0.0",
    },
    features: [],
    limits: {
      maxFrameBytes: 1,
      maxPageSize: 1,
      eventReplay: true,
      idempotencyCacheEntries: 1,
    },
  });
  assert.equal(
    parseRuntimeMethodResultForVersion("1.3", RUNTIME_METHODS.initialize, latestResult)
      .protocolVersion,
    "1.3",
  );
  assert.throws(() =>
    parseRuntimeMethodResultForVersion("1.1", RUNTIME_METHODS.initialize, latestResult),
  );
  assert.throws(() =>
    parseRuntimeMethodResultForVersion("1.1", RUNTIME_METHODS.initialize, {
      ...latestResult,
      protocolVersion: "1.4",
    }),
  );
  assert.equal(RUNTIME_EVENT_NOTIFICATION, "runtime.event");
});

test("protocol capabilities centralize version-specific control behavior", () => {
  assert.deepEqual(getRuntimeProtocolCapabilities("1.2"), RUNTIME_PROTOCOL_CAPABILITIES["1.2"]);
  assert.equal(getRuntimeProtocolCapabilities("1.2").serverRequests, true);
  assert.equal(getRuntimeProtocolCapabilities("1.2").serverRequestCapabilityNegotiation, true);
  assert.equal(
    isRuntimeServerRequestMethodRequired("1.2", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    false,
  );
  assert.equal(
    isRuntimeServerRequestMethodRequired("1.2", RUNTIME_SERVER_REQUEST_METHODS.userInputRequest),
    false,
  );
  assert.deepEqual(getRuntimeProtocolCapabilities("1.1"), RUNTIME_PROTOCOL_CAPABILITIES["1.1"]);
  assert.equal(getRuntimeProtocolCapabilities("1.1").serverRequests, true);
  assert.equal(getRuntimeProtocolCapabilities("1.1").serverRequestCapabilityNegotiation, false);
  assert.equal(getRuntimeProtocolCapabilities("1.1").approvalResolvedEvents, true);
  assert.equal(getRuntimeProtocolCapabilities("1.1").clientApprovalResponses, false);
  assert.equal(
    isRuntimeServerRequestMethodRequired("1.1", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    true,
  );
  assert.equal(getRuntimeProtocolCapabilities("1.0").serverRequests, false);
  assert.equal(getRuntimeProtocolCapabilities("1.0").serverRequestCapabilityNegotiation, false);
  assert.equal(getRuntimeProtocolCapabilities("1.0").approvalResolvedEvents, false);
  assert.equal(getRuntimeProtocolCapabilities("1.0").clientApprovalResponses, true);
  assert.equal(
    isRuntimeServerRequestMethodRequired("1.0", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    false,
  );
});

test("protocol registry isolates v1.2 capability negotiation from older versions", () => {
  assert.equal(getRuntimeProtocolRegistry("1.2"), RUNTIME_PROTOCOL_REGISTRY["1.2"]);
  assert.equal(getRuntimeProtocolRegistry("1.1"), RUNTIME_PROTOCOL_REGISTRY["1.1"]);
  assert.equal(getRuntimeProtocolRegistry("1.0"), RUNTIME_PROTOCOL_REGISTRY["1.0"]);

  assert.equal(isRuntimeMethodAvailable("1.2", RUNTIME_METHODS.clientCapabilitiesSet), true);
  assert.equal(isRuntimeMethodAvailable("1.1", RUNTIME_METHODS.clientCapabilitiesSet), false);
  assert.equal(isRuntimeMethodAvailable("1.0", RUNTIME_METHODS.clientCapabilitiesSet), false);
  assert.equal(
    isRuntimeServerRequestMethodAvailable("1.2", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    true,
  );
  assert.equal(
    isRuntimeServerRequestMethodAvailable("1.2", RUNTIME_SERVER_REQUEST_METHODS.userInputRequest),
    true,
  );
  assert.equal(
    isRuntimeServerRequestMethodAvailable("1.1", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    true,
  );
  assert.equal(
    isRuntimeServerRequestMethodAvailable("1.1", RUNTIME_SERVER_REQUEST_METHODS.userInputRequest),
    false,
  );
  assert.equal(
    isRuntimeServerRequestMethodAvailable("1.0", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    false,
  );
  assert.equal(RUNTIME_PROTOCOL_REGISTRY["1.0"].serverRequestCancelParamsSchema, null);
  assert.deepEqual(RUNTIME_PROTOCOL_REGISTRY["1.2"].serverRequestMethods, [
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
  ]);
  assert.deepEqual(
    RUNTIME_PROTOCOL_REGISTRY["1.1"].serverRequestMethods,
    RUNTIME_SERVER_REQUEST_METHOD_VALUES_V11,
  );
});

test("client.capabilities.set validates bounds and projects the ordered registry intersection", () => {
  const parsed = parseRuntimeMethodParamsForVersion("1.2", RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 7,
    serverRequestMethods: [
      RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      "future.request",
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    ],
  });
  assert.deepEqual(parsed.serverRequestMethods, [
    "userInput.request",
    "future.request",
    "approval.request",
  ]);
  assert.deepEqual(projectClientCapabilitiesSetResult(parsed), {
    revision: 7,
    acceptedServerRequestMethods: [
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
    ],
  });

  for (const value of [
    { revision: 0, serverRequestMethods: [] },
    { revision: 1.5, serverRequestMethods: [] },
    { revision: 1, serverRequestMethods: [""] },
    { revision: 1, serverRequestMethods: ["x".repeat(CLIENT_CAPABILITY_METHOD_MAX_CHARS + 1)] },
    { revision: 1, serverRequestMethods: ["duplicate", "duplicate"] },
    {
      revision: 1,
      serverRequestMethods: Array.from(
        { length: CLIENT_CAPABILITY_METHOD_MAX_COUNT + 1 },
        (_, index) => `future.${String(index)}`,
      ),
    },
  ]) {
    assert.throws(() => clientCapabilitiesSetParamsSchema.parse(value));
  }

  assert.throws(() =>
    clientCapabilitiesSetResultSchema.parse({
      revision: 1,
      acceptedServerRequestMethods: ["future.request"],
    }),
  );
  assert.throws(() =>
    clientCapabilitiesSetResultSchema.parse({
      revision: 1,
      acceptedServerRequestMethods: ["approval.request", "approval.request"],
    }),
  );
});

test("v1.2 errors stay frozen while v1.3 adds replay cursor failures", () => {
  const error = {
    rollCode: RUNTIME_ERROR_CODES.capabilityRevisionConflict,
    retryable: false,
  } as const;
  assert.equal(
    parseRuntimeProtocolErrorDataForVersion("1.2", error).rollCode,
    "CAPABILITY_REVISION_CONFLICT",
  );
  assert.equal(parseRuntimeProtocolErrorDataForVersion("1.3", error).rollCode, error.rollCode);
  assert.throws(() => runtimeProtocolErrorDataSchema.parse(error));
  assert.throws(() => parseRuntimeProtocolErrorDataForVersion("1.1", error));

  for (const rollCode of [
    RUNTIME_ERROR_CODES.eventCursorExpired,
    RUNTIME_ERROR_CODES.eventCursorGap,
  ] as const) {
    assert.equal(
      parseRuntimeProtocolErrorDataForVersion("1.3", { rollCode, retryable: false }).rollCode,
      rollCode,
    );
    assert.equal(
      (Object.values(RUNTIME_ERROR_CODES_V12) as readonly string[]).includes(rollCode),
      false,
    );
    assert.throws(() =>
      parseRuntimeProtocolErrorDataForVersion("1.2", { rollCode, retryable: false }),
    );
  }
});

test("InteractionId is validated and nominally distinct from ApprovalId", () => {
  const interactionId: InteractionId = interactionIdSchema.parse(IDS.interaction);
  const approvalId: ApprovalId = approvalIdSchema.parse(IDS.approval);
  assert.equal(interactionId, IDS.interaction);
  assert.equal(approvalId, IDS.approval);

  // @ts-expect-error ApprovalId and InteractionId must not be interchangeable.
  const wrongInteractionId: InteractionId = approvalId;
  assert.equal(wrongInteractionId, IDS.approval);
});

test("Runtime Event ids and opaque cursors are nominally distinct and null-aware", () => {
  const eventId: RuntimeEventId = runtimeEventIdSchema.parse(IDS.event);
  const first: RuntimeEventCursor = runtimeEventCursorSchema.parse(CURSORS.first);
  const second = runtimeEventCursorSchema.parse(CURSORS.second);
  assert.equal(compareRuntimeEventCursors(null, null), 0);
  assert.equal(compareRuntimeEventCursors(null, first), -1);
  assert.equal(compareRuntimeEventCursors(first, null), 1);
  assert.equal(compareRuntimeEventCursors(first, second), -1);
  assert.equal(runtimeEventCursorDistance(null, first), 1n);
  assert.equal(runtimeEventCursorDistance(null, second), 2n);
  assert.equal(runtimeEventCursorDistance(first, second), 1n);
  assert.equal(runtimeEventCursorDistance(second, null), -2n);

  // @ts-expect-error RuntimeEventId and RuntimeEventCursor must not be interchangeable.
  const wrongCursor: RuntimeEventCursor = eventId;
  assert.equal(wrongCursor, IDS.event);
  assert.throws(() =>
    compareRuntimeEventCursors(
      first,
      runtimeEventCursorSchema.parse(`rte1:${IDS.runtime}:1:${IDS.event2}`),
    ),
  );
  assert.throws(() =>
    compareRuntimeEventCursors(
      first,
      runtimeEventCursorSchema.parse(`rte1:${IDS.eventLog}:0:${IDS.event2}`),
    ),
  );
});

test("runtime.events.resume is v1.3-only and accepts the null checkpoint", () => {
  assert.equal(isRuntimeMethodAvailable("1.3", RUNTIME_METHODS.runtimeEventsResume), true);
  for (const version of SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V12) {
    assert.equal(isRuntimeMethodAvailable(version, RUNTIME_METHODS.runtimeEventsResume), false);
  }
  assert.deepEqual(
    runtimeEventsResumeParamsSchema.parse({ threadId: IDS.thread, afterCursor: null }),
    {
      threadId: IDS.thread,
      afterCursor: null,
    },
  );
  assert.deepEqual(
    runtimeEventsResumeResultSchema.parse({ throughCursor: null, replayedCount: 0 }),
    {
      throughCursor: null,
      replayedCount: 0,
    },
  );
  assert.equal(
    parseRuntimeMethodParamsForVersion("1.3", RUNTIME_METHODS.runtimeEventsResume, {
      threadId: IDS.thread,
      afterCursor: CURSORS.first,
    }).afterCursor,
    CURSORS.first,
  );
  assert.throws(() => runtimeEventsResumeParamsSchema.parse({ threadId: IDS.thread }));
});

test("runtime method registry exposes the complete v1 surface", () => {
  assert.deepEqual(Object.keys(runtimeMethodSchemas).sort(), Object.values(RUNTIME_METHODS).sort());
  assert.throws(() =>
    runtimeMethodSchemas[RUNTIME_METHODS.turnStart].params.parse({
      requestId: IDS.turn,
      threadId: IDS.thread,
      turnId: "not-a-uuid",
      input: { text: "hello" },
    }),
  );
});

test("runtime event envelope is ordered by runtime instance and sequence", () => {
  const input = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: IDS.runtime,
    sequence: 7,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    durability: "ephemeral",
    event: {
      type: "message.delta",
      streamId: IDS.stream,
      delta: "hello",
    },
  } as const;
  const parsed = runtimeEventEnvelopeV14Schema.parse(input);
  assert.equal(parsed.sequence, 7);
  assert.equal(parsed.event.type, "message.delta");
  assert.throws(() =>
    runtimeEventEnvelopeV14Schema.parse({
      ...input,
      durability: "durable",
      eventId: IDS.event,
      cursor: CURSORS.first,
    }),
  );
  assert.throws(() =>
    runtimeEventEnvelopeV13Schema.parse({
      ...input,
      eventId: IDS.event,
      cursor: CURSORS.first,
    }),
  );
});

test("runtime event envelopes project explicitly to the frozen v1.1 shape", () => {
  const latest = runtimeEventEnvelopeSchema.parse({
    protocolVersion: "1.3",
    runtimeInstanceId: IDS.runtime,
    sequence: 7,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    durability: "durable",
    eventId: IDS.event,
    cursor: CURSORS.first,
    event: {
      type: "message.completed",
      streamId: IDS.stream,
      text: "hello",
    },
  });

  assert.throws(() => runtimeEventEnvelopeV11Schema.parse(latest));
  assert.throws(() =>
    runtimeEventEnvelopeV11Schema.parse({
      ...latest,
      protocolVersion: "1.3",
    }),
  );
  const projected = projectRuntimeEventEnvelopeForVersion("1.1", latest);
  assert.deepEqual(projected, {
    protocolVersion: "1.1",
    runtimeInstanceId: IDS.runtime,
    sequence: 7,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event: latest.event,
  });
  assert.equal(runtimeEventEnvelopeV11Schema.parse(projected).protocolVersion, "1.1");
  const v12 = projectRuntimeEventEnvelopeForVersion("1.2", latest);
  assert.equal(v12.protocolVersion, "1.2");
  assert.equal("durability" in v12, false);
  assert.equal("eventId" in v12, false);
  assert.equal("cursor" in v12, false);
  assert.deepEqual(projectRuntimeEventEnvelopeForVersion("1.1", v12), projected);
  assert.throws(() => projectRuntimeEventEnvelopeForVersion("1.3", v12));
  assert.deepEqual(projectRuntimeEventEnvelopeForVersion("1.3", latest), latest);
});

test("server request registry derives typed approval request params and results", async () => {
  assert.deepEqual(
    Object.keys(runtimeServerRequestSchemas),
    RUNTIME_SERVER_REQUEST_METHOD_VALUES_V11,
  );
  assert.deepEqual(RUNTIME_SERVER_REQUEST_METHOD_VALUES, [
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
  ]);
  assert.equal(isRuntimeServerRequestMethod("approval.request"), true);
  assert.equal(isRuntimeServerRequestMethod("approval.respond"), false);

  const params = parseRuntimeServerRequestParams(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, {
    threadId: IDS.thread,
    approval: {
      id: IDS.approval,
      turnId: IDS.turn,
      agentName: "browser-use-agent",
      toolName: "click",
      preview: {
        selector: "#submit",
        [APPROVAL_EXPLANATION_PREVIEW_KEY]: "提交当前表单，以完成用户要求的操作。",
      },
      reason: "提交动作需确认",
    },
    expiresAt: "2026-07-29T12:10:00.000Z",
  });
  assert.equal(params.approval.id, IDS.approval);
  assert.equal(getApprovalExplanation(params.approval), "提交当前表单，以完成用户要求的操作。");
  assert.equal(params.approval.reason, "提交动作需确认");

  const handlers: RuntimeServerRequestHandlers = {
    [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: async () => ({
      decision: "approve",
    }),
  };
  const approvalHandler = handlers[RUNTIME_SERVER_REQUEST_METHODS.approvalRequest];
  assert.ok(approvalHandler);
  assert.equal(
    parseRuntimeServerRequestResult(
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      await approvalHandler(params),
    ).decision,
    "approve",
  );
  assert.throws(() =>
    parseRuntimeServerRequestResult(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, {
      decision: "approve",
      reason: "not valid for approval",
    }),
  );
});

test("v1.2 approval.request carries strict interaction metadata and projects to frozen v1.1", () => {
  const input = {
    interactionId: IDS.interaction,
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
      reason: "提交动作需确认",
    },
  } as const;
  const parsed = parseRuntimeServerRequestParamsForVersion(
    "1.2",
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    input,
  );
  assert.equal(parsed.interactionId, IDS.interaction);
  assert.equal(parsed.turnId, parsed.approval.turnId);
  assert.equal(parsed.sensitivity, "normal");
  assert.equal(parseNegotiatedApproval("1.2", input).approval.id, IDS.approval);

  assert.deepEqual(
    projectRuntimeServerRequestParams("1.2", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, input),
    parsed,
  );
  const projectedV11 = projectRuntimeServerRequestParams(
    "1.1",
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    input,
  );
  assert.deepEqual(projectedV11, {
    threadId: IDS.thread,
    approval: input.approval,
    expiresAt: input.expiresAt,
  });
  assert.equal("interactionId" in projectedV11, false);
  assert.equal(
    parseRuntimeServerRequestParamsForVersion(
      "1.1",
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      projectedV11,
    ).approval.id,
    IDS.approval,
  );
  assert.throws(() =>
    parseRuntimeServerRequestParams(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, parsed),
  );
  assert.throws(() =>
    projectRuntimeServerRequestParams("1.0", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, input),
  );

  for (const invalid of [
    { ...input, interactionId: undefined },
    { ...input, expiresAt: undefined },
    { ...input, sensitivity: "secret" },
    { ...input, approval: { ...input.approval, turnId: IDS.interaction } },
    { ...input, unexpected: true },
  ]) {
    assert.throws(() => approvalRequestParamsV12Schema.parse(invalid));
  }
});

test("v1.2 userInput.request derives all safe controls from one strict form schema", () => {
  const controls: UserInputForm["controls"] = [
    {
      type: "text",
      id: "deployment-region",
      label: "部署区域",
      description: "填写普通区域名称，例如 华东。",
      required: true,
      minLength: 2,
      maxLength: 20,
    },
    {
      type: "multiline",
      id: "release-notes",
      label: "发布说明",
      required: false,
      maxLength: 200,
    },
    {
      type: "number",
      id: "replicas",
      label: "实例数量",
      required: true,
      min: 1,
      max: 5,
      integer: true,
    },
    {
      type: "boolean",
      id: "dry-run",
      label: "仅预演",
      required: true,
    },
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
    {
      type: "choice",
      id: "reviewers",
      label: "复核人",
      required: false,
      multiple: true,
      minSelections: 0,
      maxSelections: 2,
      options: [
        { id: "reviewer-a", label: "复核人 A" },
        { id: "reviewer-b", label: "复核人 B" },
        { id: "reviewer-c", label: "复核人 C" },
      ],
    },
  ];
  const input = userInputRequestParams(controls) satisfies LatestRuntimeServerRequestInput<
    typeof RUNTIME_SERVER_REQUEST_METHODS.userInputRequest
  >;
  const parsed = parseRuntimeServerRequestParamsForVersion(
    "1.2",
    RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
    input,
  );
  assert.deepEqual(parsed.controls, controls);
  assert.equal(parsed.sensitivity, "normal");
  assert.deepEqual(
    userInputFormSchema.parse({
      title: parsed.title,
      description: parsed.description,
      controls: parsed.controls,
    }),
    {
      title: input.title,
      description: input.description,
      controls,
    },
  );
  assert.deepEqual(
    projectRuntimeServerRequestParams(
      "1.2",
      RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      input,
    ),
    parsed,
  );
  assert.throws(() =>
    projectRuntimeServerRequestParams(
      "1.1",
      RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      input,
    ),
  );
  assert.equal(
    isLatestRuntimeServerRequestMethod(RUNTIME_SERVER_REQUEST_METHODS.userInputRequest),
    true,
  );
  assert.equal(
    isRuntimeServerRequestMethod(RUNTIME_SERVER_REQUEST_METHODS.userInputRequest),
    false,
  );
});

test("user input form rejects unsafe bounds, duplicate ids and incoherent choice definitions", () => {
  const validText = {
    type: "text",
    id: "region",
    label: "部署区域",
    required: true,
    minLength: 1,
    maxLength: 20,
  } as const;
  const validChoice = {
    type: "choice",
    id: "workspace",
    label: "目标 Workspace",
    required: true,
    multiple: false,
    options: [
      { id: "workspace-a", label: "Workspace A" },
      { id: "workspace-b", label: "Workspace B" },
    ],
  } as const;
  assert.deepEqual(userInputFormSchema.parse({ controls: [validText, validChoice] }).controls, [
    validText,
    validChoice,
  ]);

  const invalidForms: readonly unknown[] = [
    { controls: [] },
    {
      controls: Array.from({ length: USER_INPUT_CONTROL_MAX_COUNT + 1 }, (_, index) => ({
        ...validText,
        id: `region-${String(index)}`,
      })),
    },
    { controls: [validText, { ...validChoice, id: validText.id }] },
    { controls: [{ ...validText, id: "x".repeat(USER_INPUT_CONTROL_ID_MAX_CHARS + 1) }] },
    { controls: [{ ...validText, label: "x".repeat(USER_INPUT_LABEL_MAX_CHARS + 1) }] },
    {
      description: "x".repeat(USER_INPUT_DESCRIPTION_MAX_CHARS + 1),
      controls: [validText],
    },
    { controls: [{ ...validText, minLength: 21, maxLength: 20 }] },
    { controls: [{ ...validText, minLength: undefined, maxLength: 0 }] },
    { controls: [{ ...validText, maxLength: USER_INPUT_TEXT_MAX_CHARS + 1 }] },
    {
      controls: [
        {
          type: "number",
          id: "replicas",
          label: "实例数量",
          required: true,
          min: 5,
          max: 1,
        },
      ],
    },
    {
      controls: [
        {
          type: "number",
          id: "replicas",
          label: "实例数量",
          required: true,
          integer: true,
          min: 0.1,
          max: 0.9,
        },
      ],
    },
    {
      controls: [
        {
          ...validChoice,
          options: [
            { id: "same", label: "A" },
            { id: "same", label: "B" },
          ],
        },
      ],
    },
    { controls: [{ ...validChoice, minSelections: 2, maxSelections: 1 }] },
    { controls: [{ ...validChoice, maxSelections: 2 }] },
    {
      controls: [
        {
          ...validChoice,
          multiple: true,
          maxSelections: 3,
        },
      ],
    },
    {
      controls: [
        {
          ...validChoice,
          multiple: true,
          options: Array.from({ length: USER_INPUT_CHOICE_OPTION_MAX_COUNT + 1 }, (_, index) => ({
            id: `option-${String(index)}`,
            label: `Option ${String(index)}`,
          })),
        },
      ],
    },
  ];
  for (const form of invalidForms) {
    assert.throws(() => userInputFormSchema.parse(form));
  }

  const validParams = userInputRequestParams([validText]);
  assert.throws(() =>
    userInputRequestParamsV12Schema.parse({ ...validParams, sensitivity: "secret" }),
  );
  assert.throws(() => userInputRequestParamsV12Schema.parse({ ...validParams, password: "no" }));
});

test("normalizeUserInputResult correlates values and returns form definition order", () => {
  const params = userInputRequestParams([
    {
      type: "text",
      id: "region",
      label: "部署区域",
      required: true,
      minLength: 2,
      maxLength: 10,
    },
    {
      type: "number",
      id: "replicas",
      label: "实例数量",
      required: true,
      min: 1,
      max: 5,
      integer: true,
    },
    {
      type: "boolean",
      id: "dry-run",
      label: "仅预演",
      required: true,
    },
    {
      type: "choice",
      id: "workspace",
      label: "目标 Workspace",
      required: true,
      multiple: false,
      options: [
        { id: "workspace-a", label: "Workspace A" },
        { id: "workspace-b", label: "Workspace B" },
      ],
    },
    {
      type: "choice",
      id: "reviewers",
      label: "复核人",
      required: false,
      multiple: true,
      maxSelections: 2,
      options: [
        { id: "reviewer-a", label: "复核人 A" },
        { id: "reviewer-b", label: "复核人 B" },
      ],
    },
  ]);
  const raw: UserInputResult = {
    status: "submitted",
    values: [
      { id: "reviewers", value: ["reviewer-b", "reviewer-a"] },
      { id: "workspace", value: "workspace-b" },
      { id: "dry-run", value: false },
      { id: "replicas", value: 3 },
      { id: "region", value: "华东" },
    ],
  };
  const normalized = normalizeUserInputResult(params, raw);
  assert.deepEqual(normalized, {
    status: "submitted",
    values: [
      { id: "region", value: "华东" },
      { id: "replicas", value: 3 },
      { id: "dry-run", value: false },
      { id: "workspace", value: "workspace-b" },
      { id: "reviewers", value: ["reviewer-b", "reviewer-a"] },
    ],
  });
  assert.deepEqual(normalizeUserInputResult(params, { status: "cancelled", reason: "用户取消" }), {
    status: "cancelled",
    reason: "用户取消",
  });
});

test("normalizeUserInputResult rejects missing, unknown, duplicate and incompatible values", () => {
  const params = userInputRequestParams([
    {
      type: "text",
      id: "region",
      label: "部署区域",
      required: true,
      minLength: 2,
      maxLength: 4,
    },
    {
      type: "number",
      id: "replicas",
      label: "实例数量",
      required: true,
      min: 1,
      max: 3,
      integer: true,
    },
    {
      type: "boolean",
      id: "dry-run",
      label: "仅预演",
      required: true,
    },
    {
      type: "choice",
      id: "workspace",
      label: "目标 Workspace",
      required: true,
      multiple: false,
      options: [{ id: "workspace-a", label: "Workspace A" }],
    },
    {
      type: "choice",
      id: "reviewers",
      label: "复核人",
      required: true,
      multiple: true,
      minSelections: 1,
      maxSelections: 2,
      options: [
        { id: "reviewer-a", label: "复核人 A" },
        { id: "reviewer-b", label: "复核人 B" },
        { id: "reviewer-c", label: "复核人 C" },
      ],
    },
  ]);
  const validValues = [
    { id: "region", value: "华东" },
    { id: "replicas", value: 2 },
    { id: "dry-run", value: false },
    { id: "workspace", value: "workspace-a" },
    { id: "reviewers", value: ["reviewer-a"] },
  ] as const;
  const invalidValues: readonly (readonly unknown[])[] = [
    [],
    [...validValues, { id: "unknown", value: "x" }],
    [...validValues, { id: "region", value: "华南" }],
    validValues.map((entry) => (entry.id === "region" ? { ...entry, value: 1 } : entry)),
    validValues.map((entry) => (entry.id === "region" ? { ...entry, value: "x" } : entry)),
    validValues.map((entry) => (entry.id === "region" ? { ...entry, value: "12345" } : entry)),
    validValues.map((entry) => (entry.id === "replicas" ? { ...entry, value: "2" } : entry)),
    validValues.map((entry) => (entry.id === "replicas" ? { ...entry, value: 1.5 } : entry)),
    validValues.map((entry) => (entry.id === "replicas" ? { ...entry, value: 0 } : entry)),
    validValues.map((entry) => (entry.id === "replicas" ? { ...entry, value: 4 } : entry)),
    validValues.map((entry) => (entry.id === "dry-run" ? { ...entry, value: "false" } : entry)),
    validValues.map((entry) =>
      entry.id === "workspace" ? { ...entry, value: ["workspace-a"] } : entry,
    ),
    validValues.map((entry) =>
      entry.id === "workspace" ? { ...entry, value: "workspace-b" } : entry,
    ),
    validValues.map((entry) =>
      entry.id === "reviewers" ? { ...entry, value: "reviewer-a" } : entry,
    ),
    validValues.map((entry) => (entry.id === "reviewers" ? { ...entry, value: [] } : entry)),
    validValues.map((entry) =>
      entry.id === "reviewers" ? { ...entry, value: ["reviewer-a", "reviewer-a"] } : entry,
    ),
    validValues.map((entry) =>
      entry.id === "reviewers" ? { ...entry, value: ["reviewer-unknown"] } : entry,
    ),
    validValues.map((entry) =>
      entry.id === "reviewers"
        ? { ...entry, value: ["reviewer-a", "reviewer-b", "reviewer-c"] }
        : entry,
    ),
  ];
  for (const values of invalidValues) {
    assert.throws(() => normalizeUserInputResult(params, { status: "submitted", values }));
  }
  assert.throws(() => userInputResultSchema.parse({ status: "cancelled", reason: "" }));
  assert.throws(() =>
    userInputResultSchema.parse({ status: "submitted", values: [], token: "no" }),
  );
});

test("server request legacy, latest and supported-version aliases derive from registries", () => {
  const latestInput = {
    interactionId: IDS.interaction,
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
    },
  } as const satisfies LatestRuntimeServerRequestInput<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  >;
  const latestParams: LatestRuntimeServerRequestParams<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  > = parseRuntimeServerRequestParamsForVersion(
    RUNTIME_PROTOCOL_VERSION,
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    latestInput,
  );
  const legacyInput = projectRuntimeServerRequestParams(
    "1.1",
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    latestInput,
  );
  const supportedInputs: readonly RuntimeServerRequestInputForSupportedVersions<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  >[] = [legacyInput, latestInput];
  const supportedParams: readonly RuntimeServerRequestParamsForSupportedVersions<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  >[] = [
    parseRuntimeServerRequestParams(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, legacyInput),
    latestParams,
  ];
  const latestResult: LatestRuntimeServerRequestResult<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  > = { decision: "approve" };
  const supportedResult: RuntimeServerRequestResultForSupportedVersions<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  > = latestResult;

  assert.equal(supportedInputs.length, 2);
  assert.equal(supportedParams.length, 2);
  assert.deepEqual(supportedResult, { decision: "approve" });
  assert.equal(
    isLatestRuntimeServerRequestMethod(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    true,
  );
  assert.equal(isLatestRuntimeServerRequestMethod("future.request"), false);
  assert.equal(isRuntimeServerRequestMethod(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest), true);
  assert.equal(isRuntimeServerRequestMethod("future.request"), false);
});

test("approval explanation stays inside preview for v1.0/v1.1 wire compatibility", () => {
  const approval = pendingApprovalSchema.parse({
    id: IDS.approval,
    turnId: IDS.turn,
    agentName: "roll",
    toolName: "bash",
    preview: {
      command: "pnpm test",
      explanation: "运行项目测试，确认当前修改没有破坏既有功能。",
    },
  });
  assert.equal(getApprovalExplanation(approval), "运行项目测试，确认当前修改没有破坏既有功能。");
  assert.equal(approval.reason, undefined);
  for (const preview of [
    { command: "pnpm test" },
    { explanation: 7 },
    { explanation: null },
    { explanation: "   " },
    { explanation: "x".repeat(APPROVAL_EXPLANATION_MAX_CHARS + 1) },
    [],
    null,
  ]) {
    assert.equal(getApprovalExplanation({ ...approval, preview }), undefined);
  }
  assert.throws(() =>
    pendingApprovalSchema.parse({
      ...approval,
      explanation: "顶层字段会破坏旧 strict parser",
    }),
  );

  for (const protocolVersion of ["1.1", "1.0"] as const) {
    const parsed = runtimeEventEnvelopeSchema.parse({
      protocolVersion,
      runtimeInstanceId: IDS.runtime,
      sequence: 1,
      timestamp: "2026-07-29T12:10:00.000Z",
      threadId: IDS.thread,
      turnId: IDS.turn,
      event: { type: "approval.required", approval },
    });
    assert.equal(
      parsed.event.type === "approval.required"
        ? getApprovalExplanation(parsed.event.approval)
        : undefined,
      "运行项目测试，确认当前修改没有破坏既有功能。",
    );
    if (parsed.event.type === "approval.required") {
      assert.equal(parsed.event.approval.reason, undefined);
    }
  }

  const snapshot = threadSnapshotSchema.parse({
    thread: {
      id: IDS.thread,
      title: "shell approval",
      model: "mock",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [approval],
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
    transcriptCompleteness: "complete",
    eventCursor: null,
  });
  assert.equal(
    getApprovalExplanation(snapshot.pendingApprovals[0] ?? { preview: null }),
    "运行项目测试，确认当前修改没有破坏既有功能。",
  );
  assert.equal(snapshot.pendingApprovals[0]?.reason, undefined);
});

test("server request cancellation preserves v1.1 and isolates the v1.2 interaction shape", () => {
  const parsed = runtimeServerRequestCancelParamsSchema.parse({
    serverRequestId: "rpc-7",
    approvalId: IDS.approval,
    reason: "turn-cancelled",
  });
  assert.equal(parsed.serverRequestId, "rpc-7");
  assert.equal(RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION, "runtime.serverRequest.cancel");

  const projectionInput = {
    interactionId: interactionIdSchema.parse(IDS.interaction),
    serverRequestId: "rpc-7",
    approvalId: approvalIdSchema.parse(IDS.approval),
    reason: "turn-cancelled",
  } as const;
  assert.deepEqual(projectRuntimeServerRequestCancelParams("1.2", projectionInput), {
    interactionId: IDS.interaction,
    reason: "turn-cancelled",
  });
  assert.deepEqual(projectRuntimeServerRequestCancelParams("1.1", projectionInput), {
    serverRequestId: "rpc-7",
    approvalId: IDS.approval,
    reason: "turn-cancelled",
  });
  assert.throws(() => projectRuntimeServerRequestCancelParams("1.0", projectionInput));

  const parsedV12 = parseNegotiatedCancel("1.2", {
    interactionId: IDS.interaction,
    reason: "turn-cancelled",
  });
  assert.equal("interactionId" in parsedV12, true);
  if (!("interactionId" in parsedV12)) {
    assert.fail("v1.2 cancellation must contain interactionId");
  }
  assert.equal(parsedV12.interactionId, IDS.interaction);
  assert.throws(() => runtimeServerRequestCancelParamsV12Schema.parse(parsed));
  assert.throws(() => runtimeServerRequestCancelParamsSchema.parse(parsedV12));
});

test("approval rejection reasons use the same non-empty contract", () => {
  const base = {
    requestId: IDS.turn,
    threadId: IDS.thread,
    turnId: IDS.turn,
    approvalId: IDS.approval,
    decision: "reject",
  } as const;
  assert.throws(() =>
    runtimeMethodSchemas[RUNTIME_METHODS.approvalRespond].params.parse({
      ...base,
      reason: "",
    }),
  );
  assert.equal(
    runtimeMethodSchemas[RUNTIME_METHODS.approvalRespond].params.parse({
      ...base,
      reason: "user declined",
    }).reason,
    "user declined",
  );
});

test("approval respond 的可选 scope 字段与旧客户端/旧字段双向兼容", () => {
  const base = {
    requestId: IDS.turn,
    threadId: IDS.thread,
    turnId: IDS.turn,
    approvalId: IDS.approval,
    decision: "approve",
  } as const;
  assert.equal(
    runtimeMethodSchemas[RUNTIME_METHODS.approvalRespond].params.parse({
      ...base,
      scope: "session",
    }).scope,
    "session",
  );
  assert.equal(
    runtimeMethodSchemas[RUNTIME_METHODS.approvalRespond].params.parse(base).scope,
    undefined,
  );
  assert.throws(() =>
    runtimeMethodSchemas[RUNTIME_METHODS.approvalRespond].params.parse({
      ...base,
      scope: "forever",
    }),
  );
});

test("approval resolution remains available from v1.1 onward", () => {
  const envelope = {
    runtimeInstanceId: IDS.runtime,
    sequence: 8,
    timestamp: "2026-07-29T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event: {
      type: "approval.resolved",
      approvalId: IDS.approval,
      resolution: {
        status: "resolved",
        decision: "reject",
        reason: "user declined",
      },
    },
  } as const;

  assert.equal(
    runtimeEventEnvelopeSchema.parse({
      ...envelope,
      protocolVersion: "1.2",
    }).event.type,
    "approval.resolved",
  );
  assert.equal(
    runtimeEventEnvelopeSchema.parse({
      ...envelope,
      protocolVersion: "1.1",
    }).event.type,
    "approval.resolved",
  );
  assert.throws(() =>
    runtimeEventEnvelopeSchema.parse({
      ...envelope,
      protocolVersion: "1.0",
    }),
  );
});

test("v1.2 snapshot projects only safe pending Interaction metadata to frozen legacy shapes", () => {
  const legacy = {
    thread: {
      id: IDS.thread,
      title: "pending interaction",
      model: "mock",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    transcriptCompleteness: "complete",
  } as const;
  const interaction = pendingInteractionProjectionSchema.parse({
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: "2026-07-29T12:10:00.000Z",
    sensitivity: "normal",
    approvalId: IDS.approval,
  });
  const sourceV13 = {
    ...legacy,
    pendingInteractions: [interaction],
    eventCursor: CURSORS.first,
  } as const;
  const v12 = projectThreadSnapshotForVersion("1.2", sourceV13);
  assert.deepEqual(projectThreadSnapshotForVersion("1.3", sourceV13), sourceV13);
  assert.deepEqual(projectThreadSnapshotForVersion("1.2", v12), v12);
  assert.throws(() => projectThreadSnapshotForVersion("1.3", v12));
  assert.deepEqual(v12.pendingInteractions, [interaction]);
  assert.equal("eventCursor" in v12, false);
  assert.deepEqual(Object.keys(v12.pendingInteractions[0] ?? {}).sort(), [
    "approvalId",
    "expiresAt",
    "interactionId",
    "method",
    "sensitivity",
    "threadId",
    "turnId",
  ]);
  for (const version of ["1.1", "1.0"] as const) {
    const projected = projectThreadSnapshotForVersion(version, sourceV13);
    assert.deepEqual(projected, legacy);
    assert.deepEqual(projectThreadSnapshotForVersion(version, v12), legacy);
    assert.equal("pendingInteractions" in projected, false);
    assert.deepEqual(
      parseRuntimeMethodResultForVersion(version, RUNTIME_METHODS.threadSnapshot, projected),
      legacy,
    );
  }

  assert.deepEqual(
    parseRuntimeMethodResult(RUNTIME_METHODS.threadSnapshot, legacy),
    threadSnapshotV11Schema.parse(legacy),
  );
  assert.throws(() => parseRuntimeMethodResult(RUNTIME_METHODS.threadSnapshot, v12));
  assert.throws(() => threadSnapshotV11Schema.parse(v12));
  assert.deepEqual(threadSnapshotV12Schema.parse(v12), v12);
  assert.throws(() => threadSnapshotSchema.parse(legacy));
  for (const forbidden of [
    { preview: { selector: "#submit" } },
    { payload: { secret: "do-not-project" } },
    { result: { decision: "approve" } },
    { id: "runtime:delivery-id" },
  ]) {
    assert.throws(() =>
      pendingInteractionProjectionSchema.parse({
        ...interaction,
        ...forbidden,
      }),
    );
  }
});

test("v1.3 recovery Snapshot is explicit, byte-bounded and stripped from frozen versions", () => {
  assert.equal(RUNTIME_V13_RECOVERY_SNAPSHOT_TIMESTAMP_MAX_CHARS, 64);
  const params = {
    threadId: IDS.thread,
    limit: 1,
    recovery: true,
  } as const;
  assert.deepEqual(threadSnapshotParamsV13Schema.parse(params), params);
  assert.deepEqual(
    parseRuntimeMethodParamsForVersion("1.3", RUNTIME_METHODS.threadSnapshot, params),
    params,
  );
  assert.throws(() => threadSnapshotParamsV12Schema.parse(params));
  assert.throws(() =>
    parseRuntimeMethodParamsForVersion("1.2", RUNTIME_METHODS.threadSnapshot, params),
  );

  const recovery = {
    thread: {
      id: IDS.thread,
      title: "bounded recovery",
      model: "mock",
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:00:00.000Z",
      messageCount: 1,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    pendingInteractions: [],
    transcriptCompleteness: "complete",
    eventCursor: CURSORS.first,
    recoveryProjection: true,
  } as const;
  assert.deepEqual(threadSnapshotSchema.parse(recovery), recovery);
  assert.throws(() =>
    threadSnapshotSchema.parse({
      ...recovery,
      messages: {
        items: [
          {
            sequence: 0,
            role: "assistant",
            createdAt: "2026-08-04T12:00:00.000Z",
            parts: [{ type: "text", text: "not bounded" }],
          },
        ],
        nextBeforeSequence: null,
      },
    }),
  );
  assert.throws(() =>
    threadSnapshotSchema.parse({
      ...recovery,
      thread: {
        ...recovery.thread,
        title: "x".repeat(RUNTIME_V13_RECOVERY_SNAPSHOT_METADATA_MAX_CHARS + 1),
      },
    }),
  );
  const oversizedTimestamp = `2026-08-04T12:00:00.${"1".repeat(
    RUNTIME_V13_RECOVERY_SNAPSHOT_TIMESTAMP_MAX_CHARS,
  )}Z`;
  assert.throws(() =>
    threadSnapshotSchema.parse({
      ...recovery,
      thread: { ...recovery.thread, createdAt: oversizedTimestamp },
    }),
  );
  assert.throws(() =>
    threadSnapshotSchema.parse({
      ...recovery,
      activeTurn: {
        id: IDS.turn,
        status: "running",
        startedAt: oversizedTimestamp,
      },
    }),
  );

  const v12 = projectThreadSnapshotForVersion("1.2", recovery);
  assert.equal("eventCursor" in v12, false);
  assert.equal("recoveryProjection" in v12, false);
  for (const version of ["1.1", "1.0"] as const) {
    const legacy = projectThreadSnapshotForVersion(version, recovery);
    assert.equal("eventCursor" in legacy, false);
    assert.equal("recoveryProjection" in legacy, false);
  }
});

test("v1.2 pending user input projection contains only interaction metadata and safe form fields", () => {
  const params = userInputRequestParams([
    {
      type: "choice",
      id: "workspace",
      label: "目标 Workspace",
      description: "选择本次操作的目标工作区。",
      required: true,
      multiple: false,
      options: [
        { id: "workspace-a", label: "Workspace A" },
        { id: "workspace-b", label: "Workspace B" },
      ],
    },
  ]);
  const projection = pendingUserInputInteractionProjectionSchema.parse({
    method: RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
    ...params,
  });
  assert.deepEqual(pendingInteractionProjectionSchema.parse(projection), projection);
  assert.deepEqual(Object.keys(projection).sort(), [
    "controls",
    "description",
    "expiresAt",
    "interactionId",
    "method",
    "sensitivity",
    "threadId",
    "title",
    "turnId",
  ]);
  for (const forbidden of [
    { id: "runtime-json-rpc-id" },
    { values: [{ id: "workspace", value: "workspace-a" }] },
    { result: { status: "submitted", values: [] } },
    { token: "do-not-project" },
  ]) {
    assert.throws(() =>
      pendingUserInputInteractionProjectionSchema.parse({
        ...projection,
        ...forbidden,
      }),
    );
  }

  const sourceV13 = {
    thread: {
      id: IDS.thread,
      title: "pending user input",
      model: "mock",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    activeTurn: {
      id: IDS.turn,
      status: "waiting-for-user",
      startedAt: "2026-07-29T12:00:00.000Z",
    },
    pendingApprovals: [],
    pendingInteractions: [projection],
    transcriptCompleteness: "complete",
    eventCursor: null,
  } as const;
  const v12 = projectThreadSnapshotForVersion("1.2", sourceV13);
  assert.deepEqual(v12.pendingInteractions, [projection]);
  for (const version of ["1.1", "1.0"] as const) {
    const legacy = projectThreadSnapshotForVersion(version, sourceV13);
    assert.equal(legacy.activeTurn?.status, "running");
    assert.equal("pendingInteractions" in legacy, false);
  }
});

test("v1.2 active Turn adds waiting-for-user while legacy snapshots map it to running", () => {
  const activeTurn = {
    id: IDS.turn,
    status: "waiting-for-user",
    startedAt: "2026-07-29T12:00:00.000Z",
  } as const;
  assert.deepEqual(activeTurnV12Schema.parse(activeTurn), activeTurn);
  assert.throws(() => activeTurnV11Schema.parse(activeTurn));

  const sourceV13 = {
    thread: {
      id: IDS.thread,
      title: "waiting for user",
      model: "mock",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    activeTurn,
    pendingApprovals: [],
    pendingInteractions: [],
    transcriptCompleteness: "complete",
    eventCursor: null,
  } as const;
  const v12 = projectThreadSnapshotForVersion("1.2", sourceV13);
  assert.equal(v12.activeTurn?.status, "waiting-for-user");

  for (const version of ["1.1", "1.0"] as const) {
    const projected = projectThreadSnapshotForVersion(version, sourceV13);
    assert.equal(projected.activeTurn?.status, "running");
    assert.deepEqual(
      parseRuntimeMethodResultForVersion(version, RUNTIME_METHODS.threadSnapshot, projected),
      projected,
    );
  }
});

test("thread snapshot never exposes raw Tool evidence fields", () => {
  const snapshot = threadSnapshotSchema.parse({
    thread: {
      id: IDS.thread,
      title: "demo",
      model: "mock",
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
      messageCount: 1,
    },
    messages: {
      items: [
        {
          sequence: 0,
          role: "user",
          createdAt: "2026-07-28T12:00:00.000Z",
          parts: [{ type: "text", text: "hello" }],
        },
      ],
      nextBeforeSequence: null,
    },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    pendingInteractions: [],
    transcriptCompleteness: "complete",
    eventCursor: null,
  });
  const firstPart = snapshot.messages.items[0]?.parts[0];
  assert.ok(firstPart?.type === "text");
  assert.equal(firstPart.text, "hello");
  assert.equal("raw" in snapshot.operations, false);
});

test("structured error data requires a stable Roll error code", () => {
  assert.equal(
    runtimeProtocolErrorDataSchema.parse({
      rollCode: "THREAD_NOT_FOUND",
      retryable: false,
    }).rollCode,
    "THREAD_NOT_FOUND",
  );
  assert.throws(() =>
    runtimeProtocolErrorDataSchema.parse({
      rollCode: "UNKNOWN",
      retryable: false,
    }),
  );
});

test("cross-language golden fixtures keep request, response and event compatibility", () => {
  const initialize = fixture("valid-initialize-request.json");
  assert.equal(initializeParamsSchema.parse(initialize.params).client.name, "golden-client");

  const snapshot = fixture("valid-thread-snapshot-response.json");
  assert.equal(
    parseRuntimeMethodResultForVersion("1.1", RUNTIME_METHODS.threadSnapshot, snapshot.result)
      .messages.items[0]?.parts[0]?.text,
    "hello",
  );
  assert.throws(() => threadSnapshotSchema.parse(snapshot.result));

  const recoveryRequest = fixtureV13("valid-thread-recovery-snapshot-request.json");
  assert.equal(
    parseRuntimeMethodParamsForVersion(
      "1.3",
      RUNTIME_METHODS.threadSnapshot,
      recoveryRequest.params,
    ).recovery,
    true,
  );
  const recoveryResponse = fixtureV13("valid-thread-recovery-snapshot-response.json");
  const parsedRecoveryResponse = parseRuntimeMethodResultForVersion(
    "1.3",
    RUNTIME_METHODS.threadSnapshot,
    recoveryResponse.result,
  );
  assert.equal(
    "recoveryProjection" in parsedRecoveryResponse && parsedRecoveryResponse.recoveryProjection,
    true,
  );
  assert.throws(() =>
    parseRuntimeMethodResultForVersion(
      "1.3",
      RUNTIME_METHODS.threadSnapshot,
      fixtureV13("invalid-thread-recovery-snapshot-response.json").result,
    ),
  );
  assert.throws(() =>
    parseRuntimeMethodResultForVersion(
      "1.3",
      RUNTIME_METHODS.threadSnapshot,
      fixtureV13("invalid-thread-recovery-snapshot-timestamp-response.json").result,
    ),
  );

  const snapshotV12 = fixtureV12("valid-thread-snapshot-response.json");
  assert.equal(
    parseRuntimeMethodResultForVersion("1.2", RUNTIME_METHODS.threadSnapshot, snapshotV12.result)
      .pendingInteractions[0]?.interactionId,
    IDS.interaction,
  );

  const event = fixture("valid-runtime-event-notification.json");
  assert.equal(runtimeEventEnvelopeSchema.parse(event.params).sequence, 7);

  const approvalRequest = fixture("valid-approval-request.json");
  assert.equal(approvalRequest.method, RUNTIME_SERVER_REQUEST_METHODS.approvalRequest);
  assert.equal(
    parseRuntimeServerRequestParams(
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      approvalRequest.params,
    ).approval.id,
    IDS.approval,
  );

  const approvalResponse = fixture("valid-approval-request-response.json");
  assert.equal(
    parseRuntimeServerRequestResult(
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      approvalResponse.result,
    ).decision,
    "reject",
  );

  const userInputRequest = fixtureV12("valid-user-input-request.json");
  assert.equal(userInputRequest.method, RUNTIME_SERVER_REQUEST_METHODS.userInputRequest);
  assert.equal(
    parseRuntimeServerRequestParamsForVersion(
      "1.2",
      RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      userInputRequest.params,
    ).controls[0]?.label,
    "部署区域",
  );
  const userInputResponse = fixtureV12("valid-user-input-request-response.json");
  assert.equal(
    parseRuntimeServerRequestResultForVersion(
      "1.2",
      RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      userInputResponse.result,
    ).status,
    "submitted",
  );
  assert.throws(() =>
    userInputRequestParamsV12Schema.parse(
      fixtureV12("invalid-sensitive-user-input-request.json").params,
    ),
  );
  assert.throws(() =>
    userInputResultSchema.parse(fixtureV12("invalid-user-input-request-response.json").result),
  );

  const cancelNotification = fixture("valid-server-request-cancel-notification.json");
  assert.equal(cancelNotification.method, RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION);
  const cancelParams = runtimeServerRequestCancelParamsSchema.parse(cancelNotification.params);
  assert.equal(cancelParams.serverRequestId, "approval-rpc-1");
  assert.equal(cancelParams.approvalId, IDS.approval);

  const resolvedEvent = fixture("valid-approval-resolved-event-notification.json");
  assert.equal(
    runtimeEventEnvelopeSchema.parse(resolvedEvent.params).event.type,
    "approval.resolved",
  );

  const invalidTurn = fixture("invalid-turn-start-request.json");
  assert.throws(() =>
    runtimeMethodSchemas[RUNTIME_METHODS.turnStart].params.parse(invalidTurn.params),
  );

  const invalidOperation = fixture("invalid-operation-raw-response.json");
  assert.throws(() => operationGetResultSchema.parse(invalidOperation.result));

  const invalidApprovalResponse = fixture("invalid-approval-request-response.json");
  assert.throws(() =>
    parseRuntimeServerRequestResult(
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      invalidApprovalResponse.result,
    ),
  );

  const invalidV1ResolvedEvent = fixture("invalid-v1-approval-resolved-event-notification.json");
  assert.throws(() => runtimeEventEnvelopeSchema.parse(invalidV1ResolvedEvent.params));
});

test("cross-language event fixtures reject invalid process-local ordering", () => {
  const invalidEvent = fixture("invalid-runtime-event-notification.json");
  assert.throws(() => runtimeEventEnvelopeSchema.parse(invalidEvent.params));
});

test("v1.4 attachment methods stay unavailable to v1.3 sessions", () => {
  for (const method of [
    "attachment.stage",
    "attachment.chunk",
    "attachment.commit",
    "attachment.release",
  ] as const) {
    assert.equal(isRuntimeMethodAvailable("1.4", method), true);
    assert.equal(isRuntimeMethodAvailable("1.3", method), false);
  }
});

test("turn.start attachments are accepted by v1.4 and rejected by v1.3 strict params", () => {
  const attachmentId = "00000000-0000-4000-8000-0000000000c1";
  const base = {
    requestId: "00000000-0000-4000-8000-0000000000c0",
    threadId: IDS.thread,
    turnId: IDS.turn,
  } as const;
  const withAttachments = {
    ...base,
    input: { text: "看下这张图", attachments: [attachmentId] },
  };
  const parsed = parseRuntimeMethodParamsForVersion(
    "1.4",
    RUNTIME_METHODS.turnStart,
    withAttachments,
  );
  assert.deepEqual(parsed.input.attachments, [attachmentId]);
  assert.throws(() =>
    parseRuntimeMethodParamsForVersion("1.3", RUNTIME_METHODS.turnStart, withAttachments),
  );
  assert.throws(() =>
    parseRuntimeMethodParamsForVersion("1.4", RUNTIME_METHODS.turnStart, {
      ...base,
      input: { text: "", attachments: [] },
    }),
  );
  const emptyTextWithAttachment = parseRuntimeMethodParamsForVersion(
    "1.4",
    RUNTIME_METHODS.turnStart,
    { ...base, input: { text: "", attachments: [attachmentId] } },
  );
  assert.equal(emptyTextWithAttachment.input.text, "");
});

test("v1.4 snapshot projects attachment parts down to text-only for v1.3 clients", () => {
  const snapshotV14 = {
    thread: {
      id: IDS.thread,
      title: "demo",
      model: "mock",
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
      messageCount: 1,
    },
    messages: {
      items: [
        {
          sequence: 0,
          role: "user",
          createdAt: "2026-07-28T12:00:00.000Z",
          parts: [
            { type: "text", text: "看下这张图" },
            { type: "attachment", mediaType: "image/png", bytes: 5161 },
          ],
        },
      ],
      nextBeforeSequence: null,
    },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    pendingInteractions: [],
    transcriptCompleteness: "complete",
    eventCursor: null,
  } as const;

  const v14 = projectThreadSnapshotForVersion("1.4", snapshotV14);
  assert.equal(v14.messages.items[0]?.parts.length, 2);

  const v13 = projectThreadSnapshotForVersion("1.3", snapshotV14);
  assert.deepEqual(v13.messages.items[0]?.parts, [{ type: "text", text: "看下这张图" }]);
  assert.doesNotMatch(JSON.stringify(v13), /attachment/u);

  const v11 = projectThreadSnapshotForVersion("1.1", snapshotV14);
  assert.deepEqual(v11.messages.items[0]?.parts, [{ type: "text", text: "看下这张图" }]);
});
