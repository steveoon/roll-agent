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
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_CAPABILITIES,
  RUNTIME_PROTOCOL_REGISTRY,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  RUNTIME_SERVER_REQUEST_METHODS,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V11,
  activeTurnV11Schema,
  activeTurnV12Schema,
  approvalIdSchema,
  approvalRequestParamsV12Schema,
  clientCapabilitiesSetParamsSchema,
  clientCapabilitiesSetResultSchema,
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
  operationGetResultSchema,
  parseRuntimeMethodResult,
  parseRuntimeMethodResultForVersion,
  parseRuntimeServerRequestParams,
  parseRuntimeMethodParamsForVersion,
  parseRuntimeProtocolErrorDataForVersion,
  parseRuntimeServerRequestCancelParamsForVersion,
  parseRuntimeServerRequestParamsForVersion,
  parseRuntimeServerRequestResult,
  pendingApprovalSchema,
  pendingInteractionProjectionSchema,
  projectClientCapabilitiesSetResult,
  projectRuntimeEventEnvelopeForVersion,
  projectRuntimeServerRequestCancelParams,
  projectRuntimeServerRequestParams,
  projectThreadSnapshotForVersion,
  runtimeEventEnvelopeSchema,
  runtimeEventEnvelopeV11Schema,
  runtimeMethodSchemas,
  runtimeProtocolErrorDataSchema,
  runtimeServerRequestCancelParamsSchema,
  runtimeServerRequestCancelParamsV12Schema,
  runtimeServerRequestSchemas,
  threadSnapshotSchema,
  threadSnapshotV11Schema,
  type ApprovalId,
  type InteractionId,
  type LatestRuntimeServerRequestInput,
  type LatestRuntimeServerRequestParams,
  type LatestRuntimeServerRequestResult,
  type RuntimeProtocolVersion,
  type RuntimeServerRequestCancelParamsForVersion,
  type RuntimeServerRequestHandlers,
  type RuntimeServerRequestInputForSupportedVersions,
  type RuntimeServerRequestParamsForVersion,
  type RuntimeServerRequestParamsForSupportedVersions,
  type RuntimeServerRequestResultForSupportedVersions,
} from "./index.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000001",
  thread: "00000000-0000-4000-8000-000000000002",
  turn: "00000000-0000-4000-8000-000000000003",
  stream: "00000000-0000-4000-8000-000000000004",
  approval: "00000000-0000-4000-8000-000000000005",
  interaction: "00000000-0000-4000-8000-000000000006",
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

test("initialize advertises v1.2 first without changing the strict request shape", () => {
  const input = {
    protocolVersions: [...SUPPORTED_RUNTIME_PROTOCOL_VERSIONS],
    client: { name: "fixture-client", version: "1.0.0" },
  } as const;
  const parsed = initializeParamsSchema.parse(input);
  assert.equal(RUNTIME_PROTOCOL_VERSION, "1.2");
  assert.deepEqual(parsed.protocolVersions, ["1.2", "1.1", "1.0"]);
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
    protocolVersion: "1.2",
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
  });
  assert.equal(
    parseRuntimeMethodResultForVersion("1.2", RUNTIME_METHODS.initialize, latestResult)
      .protocolVersion,
    "1.2",
  );
  assert.throws(() =>
    parseRuntimeMethodResultForVersion("1.1", RUNTIME_METHODS.initialize, latestResult),
  );
  assert.throws(() =>
    parseRuntimeMethodResultForVersion("1.1", RUNTIME_METHODS.initialize, {
      ...latestResult,
      protocolVersion: "1.3",
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
    isRuntimeServerRequestMethodAvailable("1.1", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    true,
  );
  assert.equal(
    isRuntimeServerRequestMethodAvailable("1.0", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    false,
  );
  assert.equal(RUNTIME_PROTOCOL_REGISTRY["1.0"].serverRequestCancelParamsSchema, null);
});

test("client.capabilities.set validates bounds and projects the ordered registry intersection", () => {
  const parsed = parseRuntimeMethodParamsForVersion("1.2", RUNTIME_METHODS.clientCapabilitiesSet, {
    revision: 7,
    serverRequestMethods: ["future.request", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  });
  assert.deepEqual(parsed.serverRequestMethods, ["future.request", "approval.request"]);
  assert.deepEqual(projectClientCapabilitiesSetResult(parsed), {
    revision: 7,
    acceptedServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
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

test("CAPABILITY_REVISION_CONFLICT is available only to the v1.2 error schema", () => {
  const error = {
    rollCode: RUNTIME_ERROR_CODES.capabilityRevisionConflict,
    retryable: false,
  } as const;
  assert.equal(
    parseRuntimeProtocolErrorDataForVersion("1.2", error).rollCode,
    "CAPABILITY_REVISION_CONFLICT",
  );
  assert.throws(() => runtimeProtocolErrorDataSchema.parse(error));
  assert.throws(() => parseRuntimeProtocolErrorDataForVersion("1.1", error));
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
  const parsed = runtimeEventEnvelopeSchema.parse({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: IDS.runtime,
    sequence: 7,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event: {
      type: "message.delta",
      streamId: IDS.stream,
      delta: "hello",
    },
  });
  assert.equal(parsed.sequence, 7);
  assert.equal(parsed.event.type, "message.delta");
});

test("runtime event envelopes project explicitly to the frozen v1.1 shape", () => {
  const latest = runtimeEventEnvelopeSchema.parse({
    protocolVersion: "1.2",
    runtimeInstanceId: IDS.runtime,
    sequence: 7,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event: {
      type: "message.delta",
      streamId: IDS.stream,
      delta: "hello",
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
    ...latest,
    protocolVersion: "1.1",
  });
  assert.equal(runtimeEventEnvelopeV11Schema.parse(projected).protocolVersion, "1.1");
  assert.deepEqual(projectRuntimeEventEnvelopeForVersion("1.2", latest), latest);
  assert.equal(
    projectRuntimeEventEnvelopeForVersion("1.2", {
      ...latest,
      protocolVersion: "1.1",
    }).protocolVersion,
    "1.2",
  );
});

test("server request registry derives typed approval request params and results", async () => {
  assert.deepEqual(
    Object.keys(runtimeServerRequestSchemas),
    Object.values(RUNTIME_SERVER_REQUEST_METHODS),
  );
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
  const latest = projectThreadSnapshotForVersion("1.2", {
    ...legacy,
    pendingInteractions: [interaction],
  });
  assert.deepEqual(latest.pendingInteractions, [interaction]);
  assert.deepEqual(Object.keys(latest.pendingInteractions[0] ?? {}).sort(), [
    "approvalId",
    "expiresAt",
    "interactionId",
    "method",
    "sensitivity",
    "threadId",
    "turnId",
  ]);
  for (const version of ["1.1", "1.0"] as const) {
    const projected = projectThreadSnapshotForVersion(version, latest);
    assert.deepEqual(projected, legacy);
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
  assert.throws(() => parseRuntimeMethodResult(RUNTIME_METHODS.threadSnapshot, latest));
  assert.throws(() => threadSnapshotV11Schema.parse(latest));
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

test("v1.2 active Turn adds waiting-for-user while legacy snapshots map it to running", () => {
  const activeTurn = {
    id: IDS.turn,
    status: "waiting-for-user",
    startedAt: "2026-07-29T12:00:00.000Z",
  } as const;
  assert.deepEqual(activeTurnV12Schema.parse(activeTurn), activeTurn);
  assert.throws(() => activeTurnV11Schema.parse(activeTurn));

  const latest = projectThreadSnapshotForVersion("1.2", {
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
  });
  assert.equal(latest.activeTurn?.status, "waiting-for-user");

  for (const version of ["1.1", "1.0"] as const) {
    const projected = projectThreadSnapshotForVersion(version, latest);
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
  });
  assert.equal(snapshot.messages.items[0]?.parts[0]?.text, "hello");
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
