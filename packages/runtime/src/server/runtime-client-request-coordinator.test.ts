import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  RUNTIME_SERVER_REQUEST_METHODS,
  approvalIdSchema,
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
const approvalId = approvalIdSchema.parse("00000000-0000-4000-8000-000000000362");
const turnId = turnIdSchema.parse("00000000-0000-4000-8000-000000000363");

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

function requestId(responder: MemoryResponder): JsonRpcRequest["id"] {
  const message = responder.sent.find(
    (candidate): candidate is JsonRpcRequest => "method" in candidate && "id" in candidate,
  );
  assert.ok(message);
  return message.id;
}

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
      threadId,
      turnId,
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
      threadId,
      turnId,
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
      threadId,
      turnId,
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
      threadId,
      turnId,
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
      threadId,
      turnId,
      expiresAt: "2026-07-29T11:59:59.000Z",
    },
  );

  await assert.rejects(
    pending.result,
    (error: unknown) => error instanceof RuntimeClientRequestExpiredError,
  );
  assert.deepEqual(responder.sent, []);
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
        threadId,
        turnId,
        expiresAt: "not-a-date",
      }),
    (error: unknown) =>
      error instanceof RuntimeClientRequestError && /expiresAt/u.test(error.message),
  );
  assert.deepEqual(responder.sent, []);

  const replacement = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInput(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      threadId,
      turnId,
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
      threadId,
      turnId,
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
      threadId,
      turnId,
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
      threadId,
      turnId,
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
