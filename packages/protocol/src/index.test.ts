import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  APPROVAL_EXPLANATION_MAX_CHARS,
  APPROVAL_EXPLANATION_PREVIEW_KEY,
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  RUNTIME_SERVER_REQUEST_METHODS,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  getApprovalExplanation,
  getRuntimeProtocolCapabilities,
  initializeParamsSchema,
  initializeResultSchema,
  isRuntimeServerRequestMethod,
  isRuntimeServerRequestMethodRequired,
  operationGetResultSchema,
  parseRuntimeServerRequestParams,
  parseRuntimeServerRequestResult,
  pendingApprovalSchema,
  runtimeEventEnvelopeSchema,
  runtimeMethodSchemas,
  runtimeProtocolErrorDataSchema,
  runtimeServerRequestCancelParamsSchema,
  runtimeServerRequestSchemas,
  threadSnapshotSchema,
  type RuntimeServerRequestHandlers,
} from "./index.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000001",
  thread: "00000000-0000-4000-8000-000000000002",
  turn: "00000000-0000-4000-8000-000000000003",
  stream: "00000000-0000-4000-8000-000000000004",
  approval: "00000000-0000-4000-8000-000000000005",
} as const;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/v1/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

test("initialize schema advertises v1.1 first while preserving v1.0 negotiation", () => {
  const parsed = initializeParamsSchema.parse({
    protocolVersions: [...SUPPORTED_RUNTIME_PROTOCOL_VERSIONS],
    client: { name: "fixture-client", version: "1.0.0" },
  });
  assert.equal(RUNTIME_PROTOCOL_VERSION, "1.1");
  assert.deepEqual(parsed.protocolVersions, ["1.1", "1.0"]);
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
  assert.equal(RUNTIME_EVENT_NOTIFICATION, "runtime.event");
});

test("protocol capabilities centralize version-specific control behavior", () => {
  assert.deepEqual(getRuntimeProtocolCapabilities("1.1"), RUNTIME_PROTOCOL_CAPABILITIES["1.1"]);
  assert.equal(getRuntimeProtocolCapabilities("1.1").serverRequests, true);
  assert.equal(getRuntimeProtocolCapabilities("1.1").approvalResolvedEvents, true);
  assert.equal(getRuntimeProtocolCapabilities("1.1").clientApprovalResponses, false);
  assert.equal(
    isRuntimeServerRequestMethodRequired("1.1", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    true,
  );
  assert.equal(getRuntimeProtocolCapabilities("1.0").serverRequests, false);
  assert.equal(getRuntimeProtocolCapabilities("1.0").approvalResolvedEvents, false);
  assert.equal(getRuntimeProtocolCapabilities("1.0").clientApprovalResponses, true);
  assert.equal(
    isRuntimeServerRequestMethodRequired("1.0", RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    false,
  );
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
    transcriptCompleteness: "complete",
  });
  assert.equal(
    getApprovalExplanation(snapshot.pendingApprovals[0] ?? { preview: null }),
    "运行项目测试，确认当前修改没有破坏既有功能。",
  );
  assert.equal(snapshot.pendingApprovals[0]?.reason, undefined);
});

test("server request cancellation has a stable notification envelope payload", () => {
  const parsed = runtimeServerRequestCancelParamsSchema.parse({
    serverRequestId: "rpc-7",
    approvalId: IDS.approval,
    reason: "turn-cancelled",
  });
  assert.equal(parsed.serverRequestId, "rpc-7");
  assert.equal(RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION, "runtime.serverRequest.cancel");
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

test("approval resolution is a v1.1-only terminal event", () => {
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
    threadSnapshotSchema.parse(snapshot.result).messages.items[0]?.parts[0]?.text,
    "hello",
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
