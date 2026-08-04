import assert from "node:assert/strict";
import { test } from "node:test";
import {
  relayInteractionRequestSchemaV11,
  relayRequestIdSchema,
  type RelayInteractionRequestV11,
} from "./index.ts";
import {
  RELAY_REFERENCE_ADAPTER_ERROR_CODES,
  RelayReferenceAdapterError,
  createRelayBrowserReferenceAdapter,
} from "./reference-adapter.ts";

const IDS = {
  workspace: "00000000-0000-4000-8000-000000000801",
  secondWorkspace: "00000000-0000-4000-8000-000000000802",
  interaction: "00000000-0000-4000-8000-000000000803",
  thread: "00000000-0000-4000-8000-000000000804",
  otherThread: "00000000-0000-4000-8000-000000000805",
  turn: "00000000-0000-4000-8000-000000000806",
  approval: "00000000-0000-4000-8000-000000000807",
  request: "00000000-0000-4000-8000-000000000808",
} as const;

function approvalRequest(overrides: Record<string, unknown> = {}): RelayInteractionRequestV11 {
  return relayInteractionRequestSchemaV11.parse({
    type: "interaction.request",
    workspaceId: IDS.workspace,
    relaySequence: 0,
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: "2026-08-04T12:05:00.000Z",
    sensitivity: "normal",
    method: "approval.request",
    projection: {
      approvalId: IDS.approval,
      agentName: "workspace-agent",
      toolName: "write-file",
      explanation: "Write the requested file in the target workspace.",
    },
    ...overrides,
  });
}

function userInputRequest(overrides: Record<string, unknown> = {}): RelayInteractionRequestV11 {
  return relayInteractionRequestSchemaV11.parse({
    type: "interaction.request",
    workspaceId: IDS.workspace,
    relaySequence: 0,
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: "2026-08-04T12:05:00.000Z",
    sensitivity: "normal",
    method: "userInput.request",
    projection: {
      title: "Deployment region",
      controls: [
        {
          type: "choice",
          id: "region",
          label: "Region",
          required: true,
          multiple: false,
          options: [
            { id: "sg", label: "Singapore" },
            { id: "us", label: "United States" },
          ],
        },
      ],
    },
    ...overrides,
  });
}

function deterministicRequestId() {
  return relayRequestIdSchema.parse(IDS.request);
}

function assertAdapterError(
  callback: () => unknown,
  code: (typeof RELAY_REFERENCE_ADAPTER_ERROR_CODES)[keyof typeof RELAY_REFERENCE_ADAPTER_ERROR_CODES],
): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof RelayReferenceAdapterError);
    assert.equal(error.code, code);
    return true;
  });
}

test("Browser reference adapter accepts only explicit Relay Wire 1.1", () => {
  for (const protocolVersion of ["1.0", "9.9"]) {
    assertAdapterError(
      () =>
        createRelayBrowserReferenceAdapter({
          // @ts-expect-error Exercise the JavaScript fail-closed boundary for unsupported versions.
          protocolVersion,
          createRequestId: deterministicRequestId,
        }),
      RELAY_REFERENCE_ADAPTER_ERROR_CODES.protocolVersionUnsupported,
    );
  }
});

test("Browser reference adapter can allocate a Relay request ID with Web Crypto", () => {
  const adapter = createRelayBrowserReferenceAdapter({ protocolVersion: "1.1" });
  const request = approvalRequest();
  adapter.receive(request);

  const candidate = adapter.createCandidate({
    workspaceId: request.workspaceId,
    interactionId: request.interactionId,
    method: request.method,
    candidate: { decision: "reject" },
  });
  assert.equal(relayRequestIdSchema.safeParse(candidate.requestId).success, true);
});

test("Browser reference adapter parses requests and constructs candidates from pending identity", () => {
  const adapter = createRelayBrowserReferenceAdapter({
    protocolVersion: "1.1",
    createRequestId: deterministicRequestId,
  });
  const request = approvalRequest();

  assert.deepEqual(adapter.receive(request), { status: "pending", request });
  assert.deepEqual(adapter.getPending(request.workspaceId, request.interactionId), request);
  assert.deepEqual(adapter.listPending(), [request]);

  assert.deepEqual(
    adapter.createCandidate({
      workspaceId: request.workspaceId,
      interactionId: request.interactionId,
      method: request.method,
      candidate: { decision: "approve" },
    }),
    {
      type: "runtime.request",
      requestId: IDS.request,
      workspaceId: IDS.workspace,
      method: "interaction.candidate",
      params: {
        interactionId: IDS.interaction,
        threadId: IDS.thread,
        turnId: IDS.turn,
        method: "approval.request",
        candidate: { decision: "approve" },
      },
    },
  );
  assert.deepEqual(adapter.getPending(request.workspaceId, request.interactionId), request);
});

test("Browser reference adapter applies the pending user-input form schema", () => {
  const adapter = createRelayBrowserReferenceAdapter({
    protocolVersion: "1.1",
    createRequestId: deterministicRequestId,
  });
  const request = userInputRequest();
  adapter.receive(request);

  const candidate = adapter.createCandidate({
    workspaceId: request.workspaceId,
    interactionId: request.interactionId,
    method: request.method,
    candidate: {
      status: "submitted",
      values: [{ id: "region", value: "sg" }],
    },
  });
  assert.deepEqual(candidate.params, {
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: "userInput.request",
    candidate: {
      status: "submitted",
      values: [{ id: "region", value: "sg" }],
    },
  });

  assert.throws(() =>
    adapter.createCandidate({
      workspaceId: request.workspaceId,
      interactionId: request.interactionId,
      method: request.method,
      candidate: {
        status: "submitted",
        values: [{ id: "region", value: "unknown" }],
      },
    }),
  );
  assert.deepEqual(adapter.getPending(request.workspaceId, request.interactionId), request);
});

test("method mismatch, invalid terminal identity, and late frames fail without consuming pending", () => {
  const adapter = createRelayBrowserReferenceAdapter({
    protocolVersion: "1.1",
    createRequestId: deterministicRequestId,
  });
  const request = approvalRequest();
  adapter.receive(request);

  assertAdapterError(
    () =>
      adapter.createCandidate({
        workspaceId: request.workspaceId,
        interactionId: request.interactionId,
        method: "userInput.request",
        candidate: { status: "cancelled" },
      }),
    RELAY_REFERENCE_ADAPTER_ERROR_CODES.candidateMethodMismatch,
  );
  assert.deepEqual(adapter.getPending(request.workspaceId, request.interactionId), request);

  for (const type of ["interaction.resolved", "interaction.cancelled"] as const) {
    assertAdapterError(
      () =>
        adapter.receive({
          type,
          workspaceId: request.workspaceId,
          relaySequence: 1,
          interactionId: request.interactionId,
          threadId: IDS.otherThread,
          turnId: request.turnId,
          method: request.method,
        }),
      RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionIdentityMismatch,
    );
    assert.deepEqual(adapter.getPending(request.workspaceId, request.interactionId), request);
  }

  assert.deepEqual(
    adapter.receive({
      type: "interaction.resolved",
      workspaceId: request.workspaceId,
      relaySequence: 2,
      interactionId: request.interactionId,
      threadId: request.threadId,
      turnId: request.turnId,
      method: request.method,
    }).status,
    "resolved",
  );
  assert.equal(adapter.getPending(request.workspaceId, request.interactionId), undefined);
  assertAdapterError(
    () => adapter.receive(request),
    RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionTerminated,
  );
  assertAdapterError(
    () =>
      adapter.createCandidate({
        workspaceId: request.workspaceId,
        interactionId: request.interactionId,
        method: request.method,
        candidate: { decision: "reject" },
      }),
    RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionNotPending,
  );
  assertAdapterError(
    () =>
      adapter.receive({
        type: "interaction.cancelled",
        workspaceId: request.workspaceId,
        relaySequence: 3,
        interactionId: request.interactionId,
        threadId: request.threadId,
        turnId: request.turnId,
        method: request.method,
      }),
    RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionNotPending,
  );
});

test("a matching cancellation removes exactly its pending interaction", () => {
  const adapter = createRelayBrowserReferenceAdapter({
    protocolVersion: "1.1",
    createRequestId: deterministicRequestId,
  });
  const request = userInputRequest();
  adapter.receive(request);

  const result = adapter.receive({
    type: "interaction.cancelled",
    workspaceId: request.workspaceId,
    relaySequence: 1,
    interactionId: request.interactionId,
    threadId: request.threadId,
    turnId: request.turnId,
    method: request.method,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(adapter.getPending(request.workspaceId, request.interactionId), undefined);
  assertAdapterError(
    () => adapter.receive(request),
    RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionTerminated,
  );
});

test("pending identity is scoped by workspace and duplicate requests do not create a second entry", () => {
  const adapter = createRelayBrowserReferenceAdapter({
    protocolVersion: "1.1",
    createRequestId: deterministicRequestId,
  });
  const first = approvalRequest();
  const second = approvalRequest({ workspaceId: IDS.secondWorkspace });

  assert.equal(adapter.receive(first).status, "pending");
  assert.equal(adapter.receive(first).status, "duplicate");
  assert.equal(adapter.receive(second).status, "pending");
  assert.equal(adapter.listPending().length, 2);

  assertAdapterError(
    () =>
      adapter.receive(
        approvalRequest({
          relaySequence: 4,
          projection: {
            approvalId: IDS.approval,
            agentName: "workspace-agent",
            toolName: "different-tool",
          },
        }),
      ),
    RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionConflict,
  );
  assert.equal(adapter.listPending().length, 2);
});

test("non-interaction and Relay 1.0 frames are rejected", () => {
  const adapter = createRelayBrowserReferenceAdapter({
    protocolVersion: "1.1",
    createRequestId: deterministicRequestId,
  });
  for (const frame of [
    { type: "runtime.ack", workspaceId: IDS.workspace, throughRelaySequence: 0 },
    {
      type: "device.connect",
      protocolVersion: "1.0",
      deviceId: "00000000-0000-4000-8000-000000000809",
      pairingToken: "pairing-token-with-sufficient-length",
    },
    { type: "interaction.future", workspaceId: IDS.workspace },
  ]) {
    assertAdapterError(
      () => adapter.receive(frame),
      RELAY_REFERENCE_ADAPTER_ERROR_CODES.invalidFrame,
    );
  }
});
