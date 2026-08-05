import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  RUNTIME_SERVER_REQUEST_METHODS,
  approvalIdSchema,
  interactionIdSchema,
  runtimeInstanceIdSchema,
  threadIdSchema,
  turnIdSchema,
  type JsonRpcRequest,
} from "@roll-agent/protocol";
import {
  RuntimeClientRequestCoordinator,
  RuntimeClientRequestCancelledError,
  RuntimeClientRequestError,
  RuntimeClientRequestExpiredError,
  createRuntimeClientResponderId,
  getRuntimeClientRequestCoordinatorInternal,
} from "./runtime-client-request-coordinator.ts";
import type { JsonRpcMessage } from "./protocol.ts";

class MemoryResponder {
  readonly sent: JsonRpcMessage[] = [];
  closeCalls = 0;

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

const scopeId = runtimeInstanceIdSchema.parse("00000000-0000-4000-8000-000000000360");
const threadId = threadIdSchema.parse("00000000-0000-4000-8000-000000000361");
const otherThreadId = threadIdSchema.parse("00000000-0000-4000-8000-000000000365");
const approvalId = approvalIdSchema.parse("00000000-0000-4000-8000-000000000362");
const turnId = turnIdSchema.parse("00000000-0000-4000-8000-000000000363");
const interactionId = interactionIdSchema.parse("00000000-0000-4000-8000-000000000364");

function approvalRequestInput() {
  return {
    threadId,
    approval: {
      id: approvalId,
      turnId,
      agentName: "browser-use-agent",
      toolName: "click",
      preview: { selector: "#submit" },
    },
  } as const;
}

function approvalRequestInputV12() {
  return {
    interactionId,
    threadId,
    turnId,
    expiresAt: "2099-07-28T12:05:00.000Z",
    sensitivity: "normal",
    approval: approvalRequestInput().approval,
  } as const;
}

function requestId(responder: MemoryResponder): JsonRpcRequest["id"] {
  const message = responder.sent.find(
    (candidate): candidate is JsonRpcRequest => "method" in candidate && "id" in candidate,
  );
  assert.ok(message);
  return message.id;
}

function requestMessages(responder: MemoryResponder): readonly JsonRpcRequest[] {
  return responder.sent.filter(
    (candidate): candidate is JsonRpcRequest => "method" in candidate && "id" in candidate,
  );
}

test("Protocol 1.2 does not deliver before capability ACK", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  const detach = coordinator.attachResponder(
    {
      id: responderId,
      scopeId,
      send: (message) => responder.send(message),
      close: () => responder.close(),
    },
    { acceptedServerRequestMethods: [], capabilitiesAcknowledged: false },
  );
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInputV12(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: approvalRequestInputV12().expiresAt,
      protocolVersion: "1.2",
    },
  );

  const internal = getRuntimeClientRequestCoordinatorInternal(coordinator);
  assert.deepEqual(requestMessages(responder), []);
  assert.deepEqual(internal.getPendingInteractionProjectionsForAttachment(detach, threadId), []);
  const commit = internal.setServerRequestMethodsForAttachment(
    detach,
    [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
    "capability update",
  );
  if (typeof commit !== "function") {
    assert.fail("capability update should return a commit closure");
  }
  assert.deepEqual(requestMessages(responder), []);
  assert.deepEqual(internal.getPendingInteractionProjectionsForAttachment(detach, threadId), []);
  commit();
  const expectedProjection = {
    method: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    interactionId,
    threadId,
    turnId,
    expiresAt: approvalRequestInputV12().expiresAt,
    sensitivity: "normal",
    approvalId,
  } as const;
  const delivery = requestMessages(responder)[0];
  assert.ok(delivery);
  assert.deepEqual(delivery.params, approvalRequestInputV12());
  assert.deepEqual(
    internal.getPendingInteractionProjectionsForAttachment(detach, otherThreadId),
    [],
  );
  const projections = internal.getPendingInteractionProjectionsForAttachment(detach, threadId);
  assert.deepEqual(projections, [expectedProjection]);
  const projection = projections?.[0];
  assert.ok(projection);
  assert.equal("id" in projection, false);
  assert.equal("preview" in projection, false);
  assert.equal("payload" in projection, false);
  assert.equal("result" in projection, false);

  assert.equal(
    coordinator.handleResponse(responderId, {
      jsonrpc: "2.0",
      id: delivery.id,
      result: { decision: "approve" },
    }),
    true,
  );
  assert.deepEqual(await pending.result, { decision: "approve" });
  assert.deepEqual(internal.getPendingInteractionProjectionsForAttachment(detach, threadId), []);
});

test("accepted methods cannot bypass Protocol 1.2 capability ACK", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  const detach = coordinator.attachResponder(
    {
      id: responderId,
      scopeId,
      send: (message) => responder.send(message),
      close: () => responder.close(),
    },
    {
      acceptedServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
      capabilitiesAcknowledged: false,
    },
  );
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInputV12(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: approvalRequestInputV12().expiresAt,
      protocolVersion: "1.2",
    },
  );
  const internal = getRuntimeClientRequestCoordinatorInternal(coordinator);

  assert.deepEqual(requestMessages(responder), []);
  assert.equal(internal.redeliver(approvalId, responderId), false);
  const ackCommit = internal.setServerRequestMethodsForAttachment(
    detach,
    [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
    "capability ACK",
  );
  if (typeof ackCommit !== "function") {
    assert.fail("capability ACK should return a commit closure");
  }
  ackCommit();
  const delivery = requestMessages(responder)[0];
  assert.ok(delivery);
  assert.equal(
    coordinator.handleResponse(responderId, {
      jsonrpc: "2.0",
      id: delivery.id,
      result: { decision: "approve" },
    }),
    true,
  );
  assert.deepEqual(await pending.result, { decision: "approve" });
});

test("pre-ACK id:null fails waiting interactions without affecting another responder", async () => {
  const waitingResponder = new MemoryResponder();
  const healthyResponder = new MemoryResponder();
  const waitingResponderId = createRuntimeClientResponderId();
  const healthyResponderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder(
    {
      id: waitingResponderId,
      scopeId,
      send: (message) => waitingResponder.send(message),
      close: () => waitingResponder.close(),
    },
    {
      acceptedServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
      capabilitiesAcknowledged: false,
    },
  );
  coordinator.attachResponder({
    id: healthyResponderId,
    scopeId,
    send: (message) => healthyResponder.send(message),
    close: () => healthyResponder.close(),
  });
  const waiting = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInputV12(),
    {
      key: "waiting-before-ack",
      scopeId,
      eligibleResponderId: waitingResponderId,
      approvalId,
      expiresAt: approvalRequestInputV12().expiresAt,
      protocolVersion: "1.2",
    },
  );
  const healthy = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: "healthy-default-v1.1",
      scopeId,
      eligibleResponderId: healthyResponderId,
      approvalId,
    },
  );
  const healthyDelivery = requestMessages(healthyResponder)[0];
  assert.ok(healthyDelivery);
  assert.deepEqual(requestMessages(waitingResponder), []);

  assert.equal(
    coordinator.handleResponse(waitingResponderId, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_700, message: "Parse error before ACK" },
    }),
    true,
  );
  await assert.rejects(waiting.result, /无法关联/u);
  assert.equal(waitingResponder.closeCalls, 1);
  assert.equal(healthyResponder.closeCalls, 0);
  assert.equal(
    coordinator.handleResponse(healthyResponderId, {
      jsonrpc: "2.0",
      id: healthyDelivery.id,
      result: { decision: "approve" },
    }),
    true,
  );
  assert.deepEqual(await healthy.result, { decision: "approve" });
});

test("Protocol 1.2 empty capability ACK fails an already-waiting request closed", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  const detach = coordinator.attachResponder(
    {
      id: responderId,
      scopeId,
      send: (message) => responder.send(message),
      close: () => responder.close(),
    },
    { acceptedServerRequestMethods: [], capabilitiesAcknowledged: false },
  );
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInputV12(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: approvalRequestInputV12().expiresAt,
      protocolVersion: "1.2",
    },
  );

  const commit = getRuntimeClientRequestCoordinatorInternal(
    coordinator,
  ).setServerRequestMethodsForAttachment(detach, [], "empty ACK");
  if (typeof commit !== "function") {
    assert.fail("empty ACK should return a commit closure");
  }
  commit();
  await assert.rejects(
    pending.result,
    (error: unknown) =>
      error instanceof RuntimeClientRequestError &&
      /未协商 Runtime Server Request/u.test(error.message),
  );
  assert.deepEqual(responder.sent, []);
});

test("Protocol 1.2 interaction created before capability commit stays waiting until commit", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  const detach = coordinator.attachResponder(
    {
      id: responderId,
      scopeId,
      send: (message) => responder.send(message),
      close: () => responder.close(),
    },
    { acceptedServerRequestMethods: [], capabilitiesAcknowledged: false },
  );
  const internal = getRuntimeClientRequestCoordinatorInternal(coordinator);
  const commit = internal.setServerRequestMethodsForAttachment(
    detach,
    [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
    "capability update",
  );
  if (typeof commit !== "function") {
    assert.fail("capability update should return a commit closure");
  }
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInputV12(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: approvalRequestInputV12().expiresAt,
      protocolVersion: "1.2",
    },
  );
  assert.deepEqual(requestMessages(responder), []);
  commit();
  const delivery = requestMessages(responder)[0];
  assert.ok(delivery);
  assert.deepEqual(delivery.params, approvalRequestInputV12());
  assert.equal(
    coordinator.handleResponse(responderId, {
      jsonrpc: "2.0",
      id: delivery.id,
      result: { decision: "approve" },
    }),
    true,
  );
  assert.deepEqual(await pending.result, { decision: "approve" });
});

test("Protocol 1.2 capability commit after responder detach is a no-op", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  const detach = coordinator.attachResponder(
    {
      id: responderId,
      scopeId,
      send: (message) => responder.send(message),
      close: () => responder.close(),
    },
    { acceptedServerRequestMethods: [], capabilitiesAcknowledged: false },
  );
  const internal = getRuntimeClientRequestCoordinatorInternal(coordinator);
  const commit = internal.setServerRequestMethodsForAttachment(
    detach,
    [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
    "capability update",
  );
  if (typeof commit !== "function") {
    assert.fail("capability update should return a commit closure");
  }
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInputV12(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: approvalRequestInputV12().expiresAt,
      protocolVersion: "1.2",
    },
  );
  detach();
  await assert.rejects(pending.result, RuntimeClientRequestError);
  commit();
  assert.deepEqual(requestMessages(responder), []);
});

test("Protocol 1.2 capability withdrawal cancels by InteractionId and ignores late response", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder(
    {
      id: responderId,
      scopeId,
      send: (message) => responder.send(message),
      close: () => responder.close(),
    },
    {
      acceptedServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
      capabilitiesAcknowledged: true,
    },
  );
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInputV12(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: approvalRequestInputV12().expiresAt,
      protocolVersion: "1.2",
    },
  );
  const delivery = requestMessages(responder)[0];
  assert.ok(delivery);

  const withdrawCommit = coordinator.setResponderServerRequestMethods(
    responderId,
    [],
    "capability withdrawn",
  );
  if (typeof withdrawCommit !== "function") {
    assert.fail("capability withdrawal should return a commit closure");
  }
  await assert.rejects(
    pending.result,
    (error: unknown) =>
      error instanceof RuntimeClientRequestCancelledError &&
      error.reason === "capability withdrawn",
  );
  const cancellation = responder.sent.find(
    (message) =>
      "method" in message && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  );
  assert.ok(cancellation && "method" in cancellation && !("id" in cancellation));
  assert.deepEqual(cancellation.params, {
    interactionId,
    reason: "capability withdrawn",
  });
  withdrawCommit();
  assert.equal(
    coordinator.handleResponse(responderId, {
      jsonrpc: "2.0",
      id: delivery.id,
      result: { decision: "approve" },
    }),
    false,
  );
});

test("id:null JSON-RPC error fails only the selected responder and closes it", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => responder.send(message),
    close: () => responder.close(),
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );

  assert.equal(
    coordinator.handleResponse(responderId, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_700, message: "Parse error" },
    }),
    true,
  );
  await assert.rejects(
    pending.result,
    (error: unknown) =>
      error instanceof RuntimeClientRequestError && /无法关联/u.test(error.message),
  );
  assert.equal(responder.closeCalls, 1);

  const afterFatal = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: "after-fatal-response",
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );
  await assert.rejects(
    afterFatal.result,
    (error: unknown) =>
      error instanceof RuntimeClientRequestError && /没有可处理/u.test(error.message),
  );
  assert.equal(
    responder.sent.filter((message) => "method" in message && "id" in message).length,
    1,
  );
});

test("response must come from the eligible responder", async () => {
  const eligible = new MemoryResponder();
  const other = new MemoryResponder();
  const eligibleId = createRuntimeClientResponderId();
  const otherId = createRuntimeClientResponderId();
  const unattachedId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder({
    id: eligibleId,
    scopeId,
    send: (message) => eligible.send(message),
    close: () => eligible.close(),
  });
  coordinator.attachResponder({
    id: otherId,
    scopeId,
    send: (message) => other.send(message),
    close: () => other.close(),
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: eligibleId,
      approvalId,
    },
  );
  const id = requestId(eligible);
  let settled = false;
  pending.result
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);

  assert.equal(
    coordinator.handleResponse(otherId, {
      jsonrpc: "2.0",
      id,
      result: { decision: "approve" },
    }),
    true,
  );
  await Promise.resolve();
  assert.equal(settled, false);

  assert.equal(
    coordinator.handleResponse(unattachedId, {
      jsonrpc: "2.0",
      id,
      result: { decision: "approve" },
    }),
    true,
  );
  await Promise.resolve();
  assert.equal(settled, false);

  assert.equal(
    coordinator.handleResponse(eligibleId, {
      jsonrpc: "2.0",
      id,
      result: { decision: "approve" },
    }),
    true,
  );
  assert.deepEqual(await pending.result, { decision: "approve" });
});

test("stale detach closure cannot detach a newer responder attachment with the same id", async () => {
  const first = new MemoryResponder();
  const second = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  const detachFirst = coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => first.send(message),
    close: () => first.close(),
  });
  detachFirst();
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => second.send(message),
    close: () => second.close(),
  });
  detachFirst();
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );
  const secondId = requestId(second);
  assert.equal(
    coordinator.handleResponse(responderId, {
      jsonrpc: "2.0",
      id: secondId,
      result: { decision: "reject", reason: "用户取消" },
    }),
    true,
  );
  assert.deepEqual(await pending.result, {
    decision: "reject",
    reason: "用户取消",
  });
});

test("a stale responder session cannot fail a newer attachment with the same id", async () => {
  const first = new MemoryResponder();
  const second = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  const detachFirst = coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => first.send(message),
    close: () => first.close(),
  });
  detachFirst();
  const detachSecond = coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => second.send(message),
    close: () => second.close(),
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );
  const deliveryId = requestId(second);
  const internal = getRuntimeClientRequestCoordinatorInternal(coordinator);

  assert.equal(
    internal.handleResponseForAttachment(detachFirst, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_700, message: "stale session parse error" },
    }),
    false,
  );
  assert.equal(second.closeCalls, 0);
  assert.equal(
    internal.handleResponseForAttachment(detachSecond, {
      jsonrpc: "2.0",
      id: deliveryId,
      result: { decision: "approve" },
    }),
    true,
  );
  assert.deepEqual(await pending.result, { decision: "approve" });
});

test("absolute deadline expires without delivering or approving", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator({
    now: () => Date.parse("2026-07-29T12:00:00.000Z"),
  });
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => responder.send(message),
    close: () => responder.close(),
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: "2026-07-29T11:59:59.000Z",
    },
  );

  await assert.rejects(
    pending.result,
    (error: unknown) => error instanceof RuntimeClientRequestExpiredError,
  );
  assert.deepEqual(responder.sent, []);
});

test("a response at the exact absolute deadline expires before settlement", async () => {
  const startMs = Date.parse("2026-07-29T12:00:00.000Z");
  let nowMs = startMs;
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator({ now: () => nowMs });
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => responder.send(message),
    close: () => responder.close(),
  });
  const expiresAt = new Date(startMs + 1_000).toISOString();
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt,
    },
  );
  const deliveryId = requestId(responder);

  nowMs = Date.parse(expiresAt);
  assert.equal(
    coordinator.handleResponse(responderId, {
      jsonrpc: "2.0",
      id: deliveryId,
      result: { decision: "approve" },
    }),
    true,
  );
  await assert.rejects(
    pending.result,
    (error: unknown) =>
      error instanceof RuntimeClientRequestExpiredError && error.expiresAt === expiresAt,
  );
  assert.deepEqual(responder.sent[1], {
    jsonrpc: "2.0",
    method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    params: {
      serverRequestId: deliveryId,
      approvalId,
      reason: "Runtime 请求已到期",
    },
  });
});

test("invalid absolute deadline fails before registering or delivering a request", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => responder.send(message),
    close: () => responder.close(),
  });

  assert.throws(
    () =>
      coordinator.request(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, approvalRequestInput(), {
        key: approvalId,
        scopeId,
        eligibleResponderId: responderId,
        approvalId,
        expiresAt: "not-a-date",
      }),
    (error: unknown) =>
      error instanceof RuntimeClientRequestError && /expiresAt/u.test(error.message),
  );
  assert.deepEqual(responder.sent, []);

  for (const expiresAt of [undefined, "2099-07-28T12:06:00.000Z"]) {
    assert.throws(
      () =>
        coordinator.request(
          RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
          approvalRequestInputV12(),
          {
            key: `v1.2-deadline-${String(expiresAt)}`,
            scopeId,
            eligibleResponderId: responderId,
            approvalId,
            ...(expiresAt === undefined ? {} : { expiresAt }),
            protocolVersion: "1.2",
          },
        ),
      (error: unknown) =>
        error instanceof RuntimeClientRequestError &&
        /绝对 expiresAt deadline/u.test(error.message),
    );
  }

  const replacement = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );
  assert.equal(coordinator.cancel(approvalId, "test cleanup"), true);
  await assert.rejects(
    replacement.result,
    (error: unknown) => error instanceof RuntimeClientRequestCancelledError,
  );
});

test("empty cancellation reasons are normalized and cancelAll settles every request", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => responder.send(message),
    close: () => responder.close(),
  });
  const first = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: "first-approval",
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );
  const second = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: "second-approval",
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );

  coordinator.cancelAll("");
  for (const request of [first, second]) {
    await assert.rejects(
      request.result,
      (error: unknown) =>
        error instanceof RuntimeClientRequestCancelledError &&
        error.reason === "Runtime 请求已取消",
    );
  }
  assert.equal(coordinator.cancel("first-approval", "retry"), false);
  assert.equal(coordinator.cancel("second-approval", "retry"), false);
  const cancellations = responder.sent.filter(
    (message) =>
      "method" in message && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  );
  assert.equal(cancellations.length, 2);
  assert.equal(
    cancellations.every(
      (message) =>
        "params" in message &&
        typeof message.params === "object" &&
        message.params !== null &&
        "reason" in message.params &&
        message.params.reason === "Runtime 请求已取消",
    ),
    true,
  );
});

test("far-future deadline is scheduled in bounded timer segments", async (t) => {
  const maximumTimerDelayMs = 2_147_483_647;
  const startMs = Date.parse("2026-07-29T12:00:00.000Z");
  let nowMs = startMs;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator({
    now: () => nowMs,
  });
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => responder.send(message),
    close: () => responder.close(),
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: new Date(startMs + maximumTimerDelayMs + 1_000).toISOString(),
    },
  );
  let expired = false;
  pending.result.catch(() => {
    expired = true;
  });

  nowMs += maximumTimerDelayMs;
  t.mock.timers.tick(maximumTimerDelayMs);
  await Promise.resolve();
  assert.equal(expired, false);

  nowMs += 999;
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(expired, false);

  nowMs += 1;
  t.mock.timers.tick(1);
  await assert.rejects(
    pending.result,
    (error: unknown) => error instanceof RuntimeClientRequestExpiredError,
  );
});

test("explicit redelivery retires the old delivery and preserves the logical request", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => responder.send(message),
    close: () => responder.close(),
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );
  const firstId = requestId(responder);

  assert.equal(
    getRuntimeClientRequestCoordinatorInternal(coordinator).redeliver(approvalId, responderId),
    true,
  );
  const requests = requestMessages(responder);
  assert.equal(requests.length, 2);
  const secondRequest = requests[1];
  assert.ok(secondRequest);
  const secondId = secondRequest.id;
  assert.notEqual(secondId, firstId);
  assert.deepEqual(responder.sent[1], {
    jsonrpc: "2.0",
    method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    params: {
      serverRequestId: firstId,
      approvalId,
      reason: "Runtime 请求已重新投递",
    },
  });

  assert.equal(
    coordinator.handleResponse(responderId, {
      jsonrpc: "2.0",
      id: firstId,
      result: { decision: "approve" },
    }),
    false,
  );
  assert.equal(
    coordinator.handleResponse(responderId, {
      jsonrpc: "2.0",
      id: secondId,
      result: { decision: "reject", reason: "changed mind" },
    }),
    true,
  );
  assert.deepEqual(await pending.result, {
    decision: "reject",
    reason: "changed mind",
  });
});

test("redelivery cannot switch to a different responder", async () => {
  const eligibleResponder = new MemoryResponder();
  const otherResponder = new MemoryResponder();
  const eligibleResponderId = createRuntimeClientResponderId();
  const otherResponderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder({
    id: eligibleResponderId,
    scopeId,
    send: (message) => eligibleResponder.send(message),
    close: () => eligibleResponder.close(),
  });
  coordinator.attachResponder({
    id: otherResponderId,
    scopeId,
    send: (message) => otherResponder.send(message),
    close: () => otherResponder.close(),
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId,
      approvalId,
    },
  );
  const deliveryId = requestId(eligibleResponder);

  assert.equal(
    getRuntimeClientRequestCoordinatorInternal(coordinator).redeliver(approvalId, otherResponderId),
    false,
  );
  assert.equal(otherResponder.sent.length, 0);
  assert.equal(requestMessages(eligibleResponder).length, 1);
  assert.equal(
    coordinator.handleResponse(eligibleResponderId, {
      jsonrpc: "2.0",
      id: deliveryId,
      result: { decision: "approve" },
    }),
    true,
  );
  assert.deepEqual(await pending.result, { decision: "approve" });
});

test("redelivery does not send a replacement after reentrant cancellation", async () => {
  const sent: JsonRpcMessage[] = [];
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  let reentrantCancellationStarted = false;
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => {
      sent.push(message);
      if (
        !reentrantCancellationStarted &&
        "method" in message &&
        message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION
      ) {
        reentrantCancellationStarted = true;
        assert.equal(coordinator.cancel(approvalId, "reentrant cancellation"), true);
      }
    },
    close: () => undefined,
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );

  assert.equal(
    getRuntimeClientRequestCoordinatorInternal(coordinator).redeliver(approvalId, responderId),
    false,
  );
  assert.equal(
    sent.filter((message): message is JsonRpcRequest => "method" in message && "id" in message)
      .length,
    1,
  );
  await assert.rejects(
    pending.result,
    (error: unknown) =>
      error instanceof RuntimeClientRequestCancelledError &&
      error.reason === "reentrant cancellation",
  );
});

test("redelivery does not cross the original deadline while notifying the responder", async () => {
  const startMs = Date.parse("2026-07-29T12:00:00.000Z");
  let nowMs = startMs;
  let crossedDeadline = false;
  const sent: JsonRpcMessage[] = [];
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator({ now: () => nowMs });
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => {
      sent.push(message);
      if (
        !crossedDeadline &&
        "method" in message &&
        message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION
      ) {
        crossedDeadline = true;
        nowMs = startMs + 1_000;
      }
    },
    close: () => undefined,
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: new Date(startMs + 1_000).toISOString(),
    },
  );

  assert.equal(
    getRuntimeClientRequestCoordinatorInternal(coordinator).redeliver(approvalId, responderId),
    false,
  );
  assert.equal(
    sent.filter((message): message is JsonRpcRequest => "method" in message && "id" in message)
      .length,
    1,
  );
  assert.equal(
    sent.filter(
      (message) =>
        "method" in message && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    ).length,
    2,
  );
  await assert.rejects(
    pending.result,
    (error: unknown) => error instanceof RuntimeClientRequestExpiredError,
  );
});

test("redelivery keeps the original absolute deadline", async (t) => {
  const startMs = Date.parse("2026-07-29T12:00:00.000Z");
  let nowMs = startMs;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator({ now: () => nowMs });
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => responder.send(message),
    close: () => responder.close(),
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: new Date(startMs + 1_000).toISOString(),
    },
  );

  nowMs += 500;
  t.mock.timers.tick(500);
  assert.equal(
    getRuntimeClientRequestCoordinatorInternal(coordinator).redeliver(approvalId, responderId),
    true,
  );
  const latestId = requestMessages(responder)[1]?.id;

  nowMs += 500;
  t.mock.timers.tick(500);
  await assert.rejects(
    pending.result,
    (error: unknown) => error instanceof RuntimeClientRequestExpiredError,
  );
  const cancellations = responder.sent.filter(
    (message) =>
      "method" in message && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  );
  assert.equal(cancellations.length, 2);
  assert.deepEqual(cancellations[1], {
    jsonrpc: "2.0",
    method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    params: {
      serverRequestId: latestId,
      approvalId,
      reason: "Runtime 请求已到期",
    },
  });
});

test("detaching a responder fails only its logical interactions and is idempotent", async () => {
  const first = new MemoryResponder();
  const second = new MemoryResponder();
  const firstId = createRuntimeClientResponderId();
  const secondId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  const detachFirst = coordinator.attachResponder({
    id: firstId,
    scopeId,
    send: (message) => first.send(message),
    close: () => first.close(),
  });
  coordinator.attachResponder({
    id: secondId,
    scopeId,
    send: (message) => second.send(message),
    close: () => second.close(),
  });
  const firstPending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: "first-responder-request",
      scopeId,
      eligibleResponderId: firstId,
      approvalId,
    },
  );
  const secondPending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: "second-responder-request",
      scopeId,
      eligibleResponderId: secondId,
      approvalId,
    },
  );
  const staleFirstDeliveryId = requestId(first);
  const secondDeliveryId = requestId(second);

  detachFirst();
  detachFirst();
  await assert.rejects(
    firstPending.result,
    (error: unknown) => error instanceof RuntimeClientRequestCancelledError,
  );
  assert.equal(
    first.sent.filter(
      (message) =>
        "method" in message && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
    ).length,
    1,
  );
  assert.equal(
    coordinator.handleResponse(firstId, {
      jsonrpc: "2.0",
      id: staleFirstDeliveryId,
      result: { decision: "approve" },
    }),
    false,
  );
  assert.equal(
    coordinator.handleResponse(secondId, {
      jsonrpc: "2.0",
      id: secondDeliveryId,
      result: { decision: "approve" },
    }),
    true,
  );
  assert.deepEqual(await secondPending.result, { decision: "approve" });
});

test("detaching removes the responder before a cancellation callback can create work", async () => {
  const sent: JsonRpcMessage[] = [];
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  let reentrantResult: Promise<unknown> | undefined;
  let reentrantRequestStarted = false;
  const detach = coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => {
      sent.push(message);
      if (
        !reentrantRequestStarted &&
        "method" in message &&
        message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION
      ) {
        reentrantRequestStarted = true;
        reentrantResult = coordinator.request(
          RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
          approvalRequestInput(),
          {
            key: approvalId,
            scopeId,
            eligibleResponderId: responderId,
            approvalId,
          },
        ).result;
      }
    },
    close: () => undefined,
  });
  const original = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );

  detach();
  await assert.rejects(
    original.result,
    (error: unknown) => error instanceof RuntimeClientRequestCancelledError,
  );
  const capturedReentrantResult = reentrantResult;
  assert.notEqual(capturedReentrantResult, undefined);
  if (capturedReentrantResult === undefined) {
    throw new Error("Expected the cancellation callback to create a request");
  }
  await assert.rejects(
    capturedReentrantResult,
    (error: unknown) =>
      error instanceof RuntimeClientRequestError && /没有可处理/u.test(error.message),
  );
  assert.equal(
    sent.filter((message): message is JsonRpcRequest => "method" in message && "id" in message)
      .length,
    1,
  );
});

test("cancellation retires the delivery before notifying a reentrant responder", async () => {
  const sent: JsonRpcMessage[] = [];
  const responderId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  let deliveryId: JsonRpcRequest["id"] | undefined;
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: (message) => {
      sent.push(message);
      if ("method" in message && "id" in message) {
        deliveryId = message.id;
      } else if (
        "method" in message &&
        message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION
      ) {
        const retiredDeliveryId = deliveryId;
        assert.notEqual(retiredDeliveryId, undefined);
        if (retiredDeliveryId === undefined) {
          throw new Error("Expected an active delivery before cancellation");
        }
        coordinator.handleResponse(responderId, {
          jsonrpc: "2.0",
          id: retiredDeliveryId,
          result: { decision: "approve" },
        });
      }
    },
    close: () => undefined,
  });
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );

  assert.equal(coordinator.cancel(approvalId, "cancel before response"), true);
  await assert.rejects(
    pending.result,
    (error: unknown) =>
      error instanceof RuntimeClientRequestCancelledError &&
      error.reason === "cancel before response",
  );
  assert.equal(sent.length, 2);
});

test("synchronous send failure clears the logical key for a later request", async () => {
  const responderId = createRuntimeClientResponderId();
  let sends = 0;
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder({
    id: responderId,
    scopeId,
    send: () => {
      sends += 1;
      throw new Error("transport unavailable");
    },
    close: () => undefined,
  });
  const first = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );
  await assert.rejects(first.result, /transport unavailable/u);

  const second = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
    },
  );
  await assert.rejects(second.result, /transport unavailable/u);
  assert.equal(sends, 2);
});

test("id:null failure is isolated from another responder", async () => {
  const first = new MemoryResponder();
  const second = new MemoryResponder();
  const firstId = createRuntimeClientResponderId();
  const secondId = createRuntimeClientResponderId();
  const coordinator = new RuntimeClientRequestCoordinator();
  coordinator.attachResponder({
    id: firstId,
    scopeId,
    send: (message) => first.send(message),
    close: () => first.close(),
  });
  coordinator.attachResponder({
    id: secondId,
    scopeId,
    send: (message) => second.send(message),
    close: () => second.close(),
  });
  const firstPending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: "fatal-responder-request",
      scopeId,
      eligibleResponderId: firstId,
      approvalId,
    },
  );
  const secondPending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: "healthy-responder-request",
      scopeId,
      eligibleResponderId: secondId,
      approvalId,
    },
  );
  const secondDeliveryId = requestId(second);

  coordinator.handleResponse(firstId, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32_700, message: "Parse error" },
  });
  await assert.rejects(firstPending.result, /无法关联/u);
  assert.equal(first.closeCalls, 1);
  assert.equal(second.closeCalls, 0);

  assert.equal(
    coordinator.handleResponse(secondId, {
      jsonrpc: "2.0",
      id: secondDeliveryId,
      result: { decision: "approve" },
    }),
    true,
  );
  assert.deepEqual(await secondPending.result, { decision: "approve" });
});
