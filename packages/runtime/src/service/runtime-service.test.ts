import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_V13_MIN_CLIENT_FRAME_BYTES,
  getApprovalExplanation,
  parseRuntimeMethodResultForVersion,
  requestIdSchema,
  runtimeMethodSchemas,
  threadIdSchema,
  type RuntimeEventEnvelopeV14,
  type UserInputForm,
} from "@roll-agent/protocol";
import { ThreadStore } from "../store/thread-store.ts";
import { sessionUserInputRequestIdSchema } from "../interaction/user-input-interaction-manager.ts";
import {
  createToolExecutionRecord,
  type ToolExecutionRecord,
} from "../tool-bridge/tool-execution-record.ts";
import {
  TOOL_CANCELLATION_EXECUTION_STATES,
  TOOL_OUTCOME_KINDS,
  createToolResult,
} from "../tool-bridge/normalize-result.ts";
import { AttachmentStore } from "./attachment-store.ts";
import {
  MutationRequestCache,
  RuntimeService,
  RuntimeServiceError,
  type RuntimeServiceEngine,
  type RuntimeServiceSession,
  type RuntimeUserInputInteractionEvent,
} from "./runtime-service.ts";

const IDS = {
  thread: "00000000-0000-4000-8000-000000000101",
  firstTurn: "00000000-0000-4000-8000-000000000102",
  secondTurn: "00000000-0000-4000-8000-000000000103",
  thirdTurn: "00000000-0000-4000-8000-000000000120",
  approval: "00000000-0000-4000-8000-000000000104",
  message: "00000000-0000-4000-8000-000000000105",
  operation: "00000000-0000-4000-8000-000000000106",
  requestCreate: "00000000-0000-4000-8000-000000000111",
  requestFirstTurn: "00000000-0000-4000-8000-000000000112",
  requestApprove: "00000000-0000-4000-8000-000000000113",
  requestSecondTurn: "00000000-0000-4000-8000-000000000114",
  requestCancel: "00000000-0000-4000-8000-000000000115",
  requestRename: "00000000-0000-4000-8000-000000000116",
  requestDelete: "00000000-0000-4000-8000-000000000117",
  requestDuplicateTurn: "00000000-0000-4000-8000-000000000118",
  requestDetach: "00000000-0000-4000-8000-000000000119",
  requestCacheFirst: "00000000-0000-4000-8000-000000000121",
  requestCacheSecond: "00000000-0000-4000-8000-000000000122",
  requestCacheThird: "00000000-0000-4000-8000-000000000123",
  requestThirdTurn: "00000000-0000-4000-8000-000000000124",
  requestReplayFirstTurn: "00000000-0000-4000-8000-000000000125",
  requestReplaySecondTurn: "00000000-0000-4000-8000-000000000126",
  requestReplayThirdTurn: "00000000-0000-4000-8000-000000000127",
} as const;

const APPROVAL_PROVIDER_OPTIONS_SENTINEL = "approval-provider-token-sentinel-176";
const APPROVAL_REJECTION_SENTINEL = "approval-rejection-token-sentinel-176";
const TOOL_PROVIDER_OPTIONS_SENTINEL = "tool-provider-token-sentinel-176";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-runtime-service-"));
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function execution(): ToolExecutionRecord {
  return createToolExecutionRecord({
    id: IDS.operation,
    toolCallId: "call-safe-projection",
    agentName: "demo-agent",
    toolName: "lookup",
    input: { apiKey: "secret-input" },
    result: createToolResult(
      {
        kind: TOOL_OUTCOME_KINDS.cancelled,
        reason: "user",
        executionState: TOOL_CANCELLATION_EXECUTION_STATES.notExecuted,
      },
      "visible",
      {
        raw: { token: "secret-raw" },
      },
    ),
    createdAt: "2026-07-28T12:00:00.000Z",
  });
}

function createFixture(store: ThreadStore): {
  readonly engine: RuntimeServiceEngine;
  readonly session: RuntimeServiceSession;
  readonly sendCount: () => number;
  readonly lastApproveScope: () => string | undefined;
} {
  let sends = 0;
  let resolveDecision: (() => void) | undefined;
  let cancelled = false;
  let approveScope: string | undefined;

  const session: RuntimeServiceSession = {
    id: IDS.thread,
    async *send(input) {
      sends += 1;
      cancelled = false;
      store.appendMessages(IDS.thread, [
        { role: "user", content: typeof input === "string" ? input : input.text },
      ]);
      yield { type: "message-start", messageId: IDS.message };
      yield {
        type: "confirmation-required",
        approvalId: IDS.approval,
        agentName: "demo-agent",
        toolName: "write",
        input: {
          path: "/tmp/demo",
          apiKey: "secret-preview",
          providerOptions: { configuration: APPROVAL_PROVIDER_OPTIONS_SENTINEL },
        },
        expiresAt: "2026-07-28T12:05:00.000Z",
        reason: "requires approval",
        explanation: "写入用户请求的文件，以完成当前任务。",
      };
      await new Promise<void>((resolve) => {
        resolveDecision = resolve;
      });
      if (cancelled) {
        yield {
          type: "turn-cancelled",
          reason: "user",
          message: "用户取消本轮",
        };
        return;
      }
      yield {
        type: "tool-result",
        toolCallId: "call-safe-projection",
        agentName: "demo-agent",
        toolName: "write",
        output: "visible",
        isError: false,
        display: {
          status: "completed",
          providerOptions: { configuration: TOOL_PROVIDER_OPTIONS_SENTINEL },
        },
      };
      store.appendMessages(IDS.thread, [{ role: "assistant", content: "completed" }]);
      yield { type: "text-delta", delta: "completed" };
      yield { type: "message-finish", text: "completed" };
    },
    approve(approvalId, scope) {
      if (approvalId !== IDS.approval || resolveDecision === undefined) {
        return false;
      }
      approveScope = scope;
      resolveDecision();
      resolveDecision = undefined;
      return true;
    },
    reject(approvalId) {
      if (approvalId !== IDS.approval || resolveDecision === undefined) {
        return false;
      }
      resolveDecision();
      resolveDecision = undefined;
      return true;
    },
    cancel() {
      if (resolveDecision === undefined) {
        return false;
      }
      cancelled = true;
      resolveDecision();
      resolveDecision = undefined;
      return true;
    },
    async close() {},
    getCapabilityManifest() {
      throw new Error("capabilities are not used by this fixture");
    },
    getCapabilityTurnContext() {
      return undefined;
    },
  };
  const engine: RuntimeServiceEngine = {
    async createSession(input) {
      store.createThread({
        id: IDS.thread,
        ...(input?.title !== undefined ? { title: input.title } : {}),
        model: "fixture-model",
      });
      return session;
    },
    async resumeSession(threadId) {
      assert.equal(threadId, IDS.thread);
      return session;
    },
  };
  return { engine, session, sendCount: () => sends, lastApproveScope: () => approveScope };
}

function createImmediateFixture(store: ThreadStore): {
  readonly engine: RuntimeServiceEngine;
  readonly sendCount: () => number;
} {
  let sends = 0;
  const session: RuntimeServiceSession = {
    id: IDS.thread,
    async *send(input) {
      sends += 1;
      store.appendMessages(IDS.thread, [
        { role: "user", content: typeof input === "string" ? input : input.text },
        { role: "assistant", content: "completed" },
      ]);
      yield { type: "message-start", messageId: IDS.message };
      yield { type: "message-finish", text: "completed" };
    },
    approve() {
      return false;
    },
    reject() {
      return false;
    },
    cancel() {
      return false;
    },
    async close() {},
    getCapabilityManifest() {
      throw new Error("capabilities are not used by this fixture");
    },
    getCapabilityTurnContext() {
      return undefined;
    },
  };
  const engine: RuntimeServiceEngine = {
    async createSession(input) {
      store.createThread({
        id: IDS.thread,
        ...(input?.title !== undefined ? { title: input.title } : {}),
        model: "fixture-model",
      });
      return session;
    },
    async resumeSession(threadId) {
      assert.equal(threadId, IDS.thread);
      return session;
    },
  };
  return { engine, sendCount: () => sends };
}

test("RuntimeService keeps pending approval on decision failure and cancels through listener errors", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
  const events: RuntimeEventEnvelopeV14[] = [];
  const originalCancel = fixture.session.cancel.bind(fixture.session);
  let cancelCalls = 0;
  fixture.session.cancel = () => {
    cancelCalls += 1;
    return originalCancel();
  };
  service.onEvent((event) => events.push(event));
  try {
    service.initialize({
      protocolVersions: [RUNTIME_PROTOCOL_VERSION],
      client: { name: "throwing-approval-test", version: "1.0.0" },
    });
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "Throwing approval",
      }),
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestFirstTurn,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "trigger approval" },
      }),
    );
    await nextTick();
    const required = events.find((event) => event.event.type === "approval.required");
    assert.ok(required?.event.type === "approval.required");
    const identity = {
      threadId: required.threadId,
      turnId: required.event.approval.turnId,
      approvalId: required.event.approval.id,
    };
    assert.equal(service.getPendingApprovalExpiresAt(identity), "2026-07-28T12:05:00.000Z");
    fixture.session.approve = () => {
      throw new Error("approval gate failed");
    };

    assert.throws(
      () => service.resolvePendingApproval(identity, { decision: "approve" }),
      /approval gate failed/u,
    );
    assert.deepEqual(
      service
        .snapshotThread({ threadId: required.threadId, limit: 100 })
        .pendingApprovals.map((approval) => approval.id),
      [identity.approvalId],
    );

    const unsubscribeThrowingListener = service.onEvent((event) => {
      if (event.event.type === "approval.resolved") {
        throw new Error("approval.resolved listener failed");
      }
    });
    assert.equal(
      await service.failPendingApprovalInteraction(identity, "GUI approval handler failed"),
      true,
    );
    unsubscribeThrowingListener();
    assert.equal(cancelCalls, 1);
    assert.deepEqual(
      service.snapshotThread({ threadId: required.threadId, limit: 100 }).pendingApprovals,
      [],
    );
    const resolved = events.find((event) => event.event.type === "approval.resolved");
    assert.ok(resolved?.event.type === "approval.resolved");
    assert.deepEqual(resolved.event.resolution, {
      status: "cancelled",
      reason: "GUI approval handler failed",
    });
    await nextTick();
    const failed = events.find((event) => event.event.type === "turn.failed");
    assert.ok(failed?.event.type === "turn.failed");
    assert.equal(failed.event.message, "GUI approval handler failed");
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService respondApproval 不带 scope 时 session.approve 收到 undefined", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
  try {
    service.initialize({
      protocolVersions: [RUNTIME_PROTOCOL_VERSION],
      client: { name: "scope-omitted-test", version: "1.0.0" },
    });
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "Scope omitted",
      }),
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestFirstTurn,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "trigger approval" },
      }),
    );
    await nextTick();

    await service.respondApproval(
      runtimeMethodSchemas["approval.respond"].params.parse({
        requestId: IDS.requestApprove,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        approvalId: IDS.approval,
        decision: "approve",
      }),
    );
    assert.equal(fixture.lastApproveScope(), undefined);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService redacts approval rejection reasons before durable replay", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
  const events: RuntimeEventEnvelopeV14[] = [];
  service.onEvent((event) => events.push(event));
  try {
    service.initialize({
      protocolVersions: [RUNTIME_PROTOCOL_VERSION],
      client: { name: "approval-rejection-redaction-test", version: "1.0.0" },
    });
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "Approval rejection redaction",
      }),
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestFirstTurn,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "trigger approval" },
      }),
    );
    await nextTick();
    const required = events.find((event) => event.event.type === "approval.required");
    assert.ok(required?.event.type === "approval.required");

    assert.deepEqual(
      service.resolvePendingApproval(
        {
          threadId: required.threadId,
          turnId: required.event.approval.turnId,
          approvalId: required.event.approval.id,
        },
        {
          decision: "reject",
          reason: `apiKey=${APPROVAL_REJECTION_SENTINEL}`,
        },
      ),
      { resolved: true },
    );

    const resolved = events.find((event) => event.event.type === "approval.resolved");
    assert.ok(resolved?.event.type === "approval.resolved");
    assert.equal(JSON.stringify(resolved).includes(APPROVAL_REJECTION_SENTINEL), false);
    assert.equal(JSON.stringify(resolved).includes("[redacted]"), true);

    const replay = store.resumeRuntimeEvents(required.threadId, null);
    const replayedResolution = replay.events.find(
      (event) => event.event.type === "approval.resolved",
    );
    assert.ok(replayedResolution?.event.type === "approval.resolved");
    assert.equal(JSON.stringify(replayedResolution).includes(APPROVAL_REJECTION_SENTINEL), false);
    assert.equal(JSON.stringify(replayedResolution).includes("[redacted]"), true);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService cancelTurn releases the approval gate when a resolved listener throws", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
  const events: RuntimeEventEnvelopeV14[] = [];
  const originalCancel = fixture.session.cancel.bind(fixture.session);
  let cancelCalls = 0;
  fixture.session.cancel = () => {
    cancelCalls += 1;
    return originalCancel();
  };
  service.onEvent((event) => events.push(event));
  try {
    service.initialize({
      protocolVersions: [RUNTIME_PROTOCOL_VERSION],
      client: { name: "throwing-cancel-listener-test", version: "1.0.0" },
    });
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "Throwing cancel listener",
      }),
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestFirstTurn,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "trigger approval" },
      }),
    );
    await nextTick();
    assert.equal(
      events.some((event) => event.event.type === "approval.required"),
      true,
    );
    const unsubscribeThrowingListener = service.onEvent((event) => {
      if (event.event.type === "approval.resolved") {
        throw new Error("approval.resolved listener failed");
      }
    });

    assert.deepEqual(
      await service.cancelTurn(
        runtimeMethodSchemas["turn.cancel"].params.parse({
          requestId: IDS.requestCancel,
          threadId: IDS.thread,
          turnId: IDS.firstTurn,
        }),
      ),
      { cancelling: true },
    );
    unsubscribeThrowingListener();
    assert.equal(cancelCalls, 1);
    assert.deepEqual(
      service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 100 })
        .pendingApprovals,
      [],
    );
    await nextTick();
    assert.equal(
      events.some((event) => event.event.type === "turn.cancelled"),
      true,
    );
    assert.equal(
      service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 100 }).activeTurn,
      undefined,
    );
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService isolates event listeners before starting and completing a Turn", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
  const eventsAfterThrow: RuntimeEventEnvelopeV14[] = [];
  service.onEvent(() => {
    throw new Error("listener failed");
  });
  service.onEvent((event) => eventsAfterThrow.push(event));
  try {
    service.initialize({
      protocolVersions: [RUNTIME_PROTOCOL_VERSION],
      client: { name: "isolated-listener-test", version: "1.0.0" },
    });
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "Isolated listener",
      }),
    );
    assert.deepEqual(
      await service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId: IDS.requestFirstTurn,
          threadId: IDS.thread,
          turnId: IDS.firstTurn,
          input: { text: "complete despite listener failure" },
        }),
      ),
      { accepted: true, turnId: IDS.firstTurn },
    );
    await nextTick();

    assert.deepEqual(
      eventsAfterThrow.map((event) => event.event.type),
      ["turn.started", "message.started", "message.completed", "turn.completed"],
    );
    assert.equal(fixture.sendCount(), 1);
    assert.equal(
      service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 100 }).activeTurn,
      undefined,
    );
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MutationRequestCache bounds settled results and retains failures inside the window", async () => {
  const cache = new MutationRequestCache(2);
  const first = runtimeMethodSchemas["thread.detach"].params.parse({
    requestId: IDS.requestCacheFirst,
    threadId: IDS.thread,
  });
  const second = runtimeMethodSchemas["thread.detach"].params.parse({
    requestId: IDS.requestCacheSecond,
    threadId: IDS.thread,
  });
  const third = runtimeMethodSchemas["thread.detach"].params.parse({
    requestId: IDS.requestCacheThird,
    threadId: IDS.thread,
  });
  let firstCalls = 0;
  let failureCalls = 0;
  let thirdCalls = 0;
  const retainedFailure = new Error("retained failure");

  assert.deepEqual(
    await cache.run(first.requestId, "thread.detach", first, () => {
      firstCalls += 1;
      return { detached: true };
    }),
    { detached: true },
  );
  assert.deepEqual(
    await cache.run(first.requestId, "thread.detach", first, () => {
      firstCalls += 1;
      return { detached: false };
    }),
    { detached: true },
  );
  assert.equal(firstCalls, 1);

  await assert.rejects(
    cache.run(second.requestId, "thread.detach", second, () => {
      failureCalls += 1;
      throw retainedFailure;
    }),
    retainedFailure,
  );
  await assert.rejects(
    cache.run(second.requestId, "thread.detach", second, () => {
      failureCalls += 1;
      return { detached: true };
    }),
    retainedFailure,
  );
  assert.equal(failureCalls, 1);

  assert.deepEqual(
    await cache.run(first.requestId, "thread.detach", first, () => {
      firstCalls += 1;
      return { detached: false };
    }),
    { detached: true },
  );
  await cache.run(third.requestId, "thread.detach", third, () => {
    thirdCalls += 1;
    return { detached: true };
  });
  assert.equal(thirdCalls, 1);

  assert.deepEqual(
    await cache.run(first.requestId, "thread.detach", first, () => {
      firstCalls += 1;
      return { detached: false };
    }),
    { detached: true },
  );
  assert.equal(firstCalls, 1);

  assert.deepEqual(
    await cache.run(second.requestId, "thread.detach", second, () => {
      failureCalls += 1;
      return { detached: true };
    }),
    { detached: true },
  );
  assert.equal(failureCalls, 2);
  assert.throws(
    () =>
      cache.run(
        second.requestId,
        "thread.detach",
        { ...second, threadId: threadIdSchema.parse(IDS.firstTurn) },
        () => ({ detached: true }),
      ),
    RuntimeServiceError,
  );
});

test("MutationRequestCache keeps in-flight mutations outside the settled LRU", async () => {
  const cache = new MutationRequestCache(1);
  const first = runtimeMethodSchemas["thread.detach"].params.parse({
    requestId: IDS.requestCacheFirst,
    threadId: IDS.thread,
  });
  const second = runtimeMethodSchemas["thread.detach"].params.parse({
    requestId: IDS.requestCacheSecond,
    threadId: IDS.thread,
  });
  let resolveFirst!: (result: { readonly detached: boolean }) => void;
  const firstResult = new Promise<{ readonly detached: boolean }>((resolve) => {
    resolveFirst = resolve;
  });
  let firstCalls = 0;
  let secondCalls = 0;

  const pendingFirst = cache.run(first.requestId, "thread.detach", first, () => {
    firstCalls += 1;
    return firstResult;
  });
  await cache.run(second.requestId, "thread.detach", second, () => {
    secondCalls += 1;
    return { detached: true };
  });
  const duplicateFirst = cache.run(first.requestId, "thread.detach", first, () => {
    firstCalls += 1;
    return { detached: false };
  });
  assert.throws(
    () =>
      cache.run(
        first.requestId,
        "thread.detach",
        { ...first, threadId: threadIdSchema.parse(IDS.firstTurn) },
        () => ({ detached: false }),
      ),
    RuntimeServiceError,
  );
  assert.deepEqual(
    await cache.run(second.requestId, "thread.detach", second, () => {
      secondCalls += 1;
      return { detached: false };
    }),
    { detached: true },
  );
  assert.equal(secondCalls, 1);

  resolveFirst({ detached: true });
  assert.deepEqual(await pendingFirst, { detached: true });
  assert.deepEqual(await duplicateFirst, { detached: true });
  assert.equal(firstCalls, 1);

  await cache.run(second.requestId, "thread.detach", second, () => {
    secondCalls += 1;
    return { detached: false };
  });
  assert.equal(secondCalls, 2);
});

test("RuntimeService keeps active turn ownership outside the settled turn window", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store, {
    idempotencyCacheEntries: 1,
  });
  try {
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "Active turn owner",
      }),
    );
    const firstTurn = runtimeMethodSchemas["turn.start"].params.parse({
      requestId: IDS.requestFirstTurn,
      threadId: IDS.thread,
      turnId: IDS.firstTurn,
      input: { text: "first request" },
    });
    await service.startTurn(firstTurn);
    await nextTick();

    await service.renameThread(
      runtimeMethodSchemas["thread.rename"].params.parse({
        requestId: IDS.requestRename,
        threadId: IDS.thread,
        title: "Mutation while turn is active",
      }),
    );
    assert.equal(
      (
        await service.startTurn(
          runtimeMethodSchemas["turn.start"].params.parse({
            requestId: IDS.requestDuplicateTurn,
            threadId: IDS.thread,
            turnId: IDS.firstTurn,
            input: { text: "must not execute" },
          }),
        )
      ).accepted,
      true,
    );
    await nextTick();
    assert.equal(fixture.sendCount(), 1);

    assert.equal(
      (
        await service.cancelTurn(
          runtimeMethodSchemas["turn.cancel"].params.parse({
            requestId: IDS.requestCancel,
            threadId: IDS.thread,
            turnId: IDS.firstTurn,
          }),
        )
      ).cancelling,
      true,
    );
    await nextTick();
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService bounds completed turnId dedupe with an LRU window", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  const service = new RuntimeService(fixture.engine, store, {
    idempotencyCacheEntries: 2,
  });
  const startTurn = async (requestId: string, turnId: string, text: string): Promise<void> => {
    assert.equal(
      (
        await service.startTurn(
          runtimeMethodSchemas["turn.start"].params.parse({
            requestId,
            threadId: IDS.thread,
            turnId,
            input: { text },
          }),
        )
      ).accepted,
      true,
    );
    await nextTick();
  };
  try {
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "Settled turn owners",
      }),
    );
    await startTurn(IDS.requestFirstTurn, IDS.firstTurn, "first");
    await startTurn(IDS.requestSecondTurn, IDS.secondTurn, "second");
    await startTurn(IDS.requestThirdTurn, IDS.thirdTurn, "third");
    assert.equal(fixture.sendCount(), 3);

    await startTurn(IDS.requestReplaySecondTurn, IDS.secondTurn, "second duplicate");
    assert.equal(fixture.sendCount(), 3);

    await startTurn(IDS.requestReplayFirstTurn, IDS.firstTurn, "first after eviction");
    assert.equal(fixture.sendCount(), 4);

    await startTurn(IDS.requestDuplicateTurn, IDS.secondTurn, "second remains recent");
    assert.equal(fixture.sendCount(), 4);

    await startTurn(IDS.requestReplayThirdTurn, IDS.thirdTurn, "third after eviction");
    assert.equal(fixture.sendCount(), 5);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService durable event Store 失败时不发布 live 且回滚 turn.started", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  const service = new RuntimeService(fixture.engine, store);
  let database: DatabaseSync | undefined;
  const events: RuntimeEventEnvelopeV14[] = [];
  service.onEvent((event) => events.push(event));
  try {
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "durable failure",
      }),
    );
    database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_runtime_event_insert
      BEFORE INSERT ON runtime_events
      BEGIN
        SELECT RAISE(ABORT, 'blocked runtime event insert');
      END;
    `);

    await assert.rejects(
      service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId: IDS.requestFirstTurn,
          threadId: IDS.thread,
          turnId: IDS.firstTurn,
          input: { text: "must not execute" },
        }),
      ),
      /blocked runtime event insert/u,
    );
    assert.equal(fixture.sendCount(), 0);
    assert.deepEqual(events, []);
    const snapshot = service.snapshotThread({
      threadId: threadIdSchema.parse(IDS.thread),
      limit: 100,
    });
    assert.equal(snapshot.activeTurn, undefined);
    assert.equal(snapshot.eventCursor, null);
  } finally {
    database?.close();
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService terminal durable 写盘失败会触发 fatal shutdown signal", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  const service = new RuntimeService(fixture.engine, store);
  let database: DatabaseSync | undefined;
  const events: RuntimeEventEnvelopeV14[] = [];
  const fatalErrors: unknown[] = [];
  service.onEvent((event) => events.push(event));
  service.onFatalError((error) => fatalErrors.push(error));
  try {
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "terminal durable failure",
      }),
    );
    database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_terminal_runtime_event
      BEFORE INSERT ON runtime_events
      WHEN NEW.event_json LIKE '%"turn.completed"%'
      BEGIN
        SELECT RAISE(ABORT, 'blocked terminal runtime event insert');
      END;
    `);

    assert.equal(
      (
        await service.startTurn(
          runtimeMethodSchemas["turn.start"].params.parse({
            requestId: IDS.requestFirstTurn,
            threadId: IDS.thread,
            turnId: IDS.firstTurn,
            input: { text: "complete then fail persistence" },
          }),
        )
      ).accepted,
      true,
    );
    await nextTick();

    assert.equal(fatalErrors.length, 1);
    assert.match(String(fatalErrors[0]), /blocked terminal runtime event insert/u);
    assert.equal(
      events.some((event) => event.event.type === "turn.completed"),
      false,
    );
    assert.equal(
      service
        .resumeEvents({ threadId: threadIdSchema.parse(IDS.thread), afterCursor: null })
        .events.some((event) => event.event.type === "turn.completed"),
      false,
    );
  } finally {
    database?.close();
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService approval resolution durable 写盘失败会触发 fatal shutdown signal", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store);
  let database: DatabaseSync | undefined;
  const events: RuntimeEventEnvelopeV14[] = [];
  const fatalErrors: unknown[] = [];
  service.onEvent((event) => events.push(event));
  service.onFatalError((error) => fatalErrors.push(error));
  try {
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "approval durable failure",
      }),
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestFirstTurn,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "approve then fail persistence" },
      }),
    );
    await nextTick();
    const required = events.find((event) => event.event.type === "approval.required");
    assert.ok(required?.event.type === "approval.required");
    const identity = {
      threadId: required.threadId,
      turnId: required.event.approval.turnId,
      approvalId: required.event.approval.id,
    };
    database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_approval_resolution_runtime_event
      BEFORE INSERT ON runtime_events
      WHEN NEW.event_json LIKE '%"approval.resolved"%'
      BEGIN
        SELECT RAISE(ABORT, 'blocked approval resolution runtime event insert');
      END;
    `);

    assert.throws(
      () => service.resolvePendingApproval(identity, { decision: "approve" }),
      /blocked approval resolution runtime event insert/u,
    );
    assert.equal(fatalErrors.length, 1);
    assert.match(String(fatalErrors[0]), /blocked approval resolution runtime event insert/u);
    assert.equal(
      events.some((event) => event.event.type === "approval.resolved"),
      false,
    );
  } finally {
    database?.close();
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService v1 supports lifecycle, concurrent approval/cancel and process-local dedupe", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
  const events: RuntimeEventEnvelopeV14[] = [];
  let terminalSnapshotHadActiveTurn = false;
  service.onEvent((event) => {
    events.push(event);
    if (
      event.event.type === "turn.completed" ||
      event.event.type === "turn.cancelled" ||
      event.event.type === "turn.failed"
    ) {
      terminalSnapshotHadActiveTurn ||=
        service.snapshotThread({
          threadId: event.threadId,
          limit: 100,
        }).activeTurn !== undefined;
    }
  });
  try {
    const initialized = service.initialize({
      protocolVersions: [RUNTIME_PROTOCOL_VERSION],
      client: { name: "test-client", version: "1.0.0" },
    });
    assert.equal(initialized.protocolVersion, RUNTIME_PROTOCOL_VERSION);
    assert.equal(initialized.limits.eventReplay, true);
    assert.equal(initialized.limits.idempotencyCacheEntries, 10_000);

    const created = await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "Original",
      }),
    );
    assert.equal(created.thread.id, IDS.thread);
    assert.equal(
      (
        await service.createThread(
          runtimeMethodSchemas["thread.create"].params.parse({
            requestId: IDS.requestCreate,
            title: "Original",
          }),
        )
      ).thread.id,
      IDS.thread,
    );
    assert.equal(service.listThreads({ limit: 100 }).items.length, 1);
    assert.equal(
      (await service.openThread({ threadId: threadIdSchema.parse(IDS.thread) })).thread.id,
      IDS.thread,
    );

    const firstTurn = runtimeMethodSchemas["turn.start"].params.parse({
      requestId: IDS.requestFirstTurn,
      threadId: IDS.thread,
      turnId: IDS.firstTurn,
      input: { text: "first request" },
    });
    assert.equal((await service.startTurn(firstTurn)).accepted, true);
    assert.equal(
      (
        await service.startTurn({
          ...firstTurn,
          requestId: requestIdSchema.parse(IDS.requestDuplicateTurn),
        })
      ).accepted,
      true,
    );
    await nextTick();
    assert.equal(fixture.sendCount(), 1);
    const approvalEvent = events.find((event) => event.event.type === "approval.required");
    assert.ok(approvalEvent?.event.type === "approval.required");
    assert.equal(
      JSON.stringify(approvalEvent.event.approval.preview).includes("secret-preview"),
      false,
    );
    assert.equal(
      JSON.stringify(approvalEvent.event.approval.preview).includes(
        APPROVAL_PROVIDER_OPTIONS_SENTINEL,
      ),
      false,
    );
    assert.equal(
      getApprovalExplanation(approvalEvent.event.approval),
      "写入用户请求的文件，以完成当前任务。",
    );
    assert.equal(approvalEvent.event.approval.reason, "requires approval");
    const approvalSnapshot = service.snapshotThread({
      threadId: approvalEvent.threadId,
      limit: 100,
    }).pendingApprovals[0];
    assert.ok(approvalSnapshot);
    assert.equal(getApprovalExplanation(approvalSnapshot), "写入用户请求的文件，以完成当前任务。");
    assert.equal(approvalSnapshot.reason, "requires approval");

    await service.respondApproval(
      runtimeMethodSchemas["approval.respond"].params.parse({
        requestId: IDS.requestApprove,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        approvalId: IDS.approval,
        decision: "approve",
      }),
    );
    const approvalResolvedIndex = events.findIndex(
      (event) => event.event.type === "approval.resolved",
    );
    assert.ok(approvalResolvedIndex > events.indexOf(approvalEvent));
    const approvalResolved = events[approvalResolvedIndex];
    assert.ok(approvalResolved?.event.type === "approval.resolved");
    assert.deepEqual(approvalResolved.event, {
      type: "approval.resolved",
      approvalId: IDS.approval,
      resolution: { status: "resolved", decision: "approve" },
    });
    await nextTick();
    const toolCompleted = events.find((event) => event.event.type === "tool.completed");
    assert.ok(toolCompleted?.event.type === "tool.completed");
    assert.equal(
      JSON.stringify(toolCompleted.event.display).includes(TOOL_PROVIDER_OPTIONS_SENTINEL),
      false,
    );
    const completedIndex = events.findIndex((event) => event.event.type === "turn.completed");
    assert.ok(completedIndex > approvalResolvedIndex);

    const secondTurn = runtimeMethodSchemas["turn.start"].params.parse({
      requestId: IDS.requestSecondTurn,
      threadId: IDS.thread,
      turnId: IDS.secondTurn,
      input: { text: "second request" },
    });
    await service.startTurn(secondTurn);
    await nextTick();
    assert.equal(
      (
        await service.cancelTurn(
          runtimeMethodSchemas["turn.cancel"].params.parse({
            requestId: IDS.requestCancel,
            threadId: IDS.thread,
            turnId: IDS.secondTurn,
          }),
        )
      ).cancelling,
      true,
    );
    await nextTick();
    assert.equal(
      events.some((event) => event.event.type === "turn.cancelled"),
      true,
    );
    assert.equal(terminalSnapshotHadActiveTurn, false);
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_event, index) => index),
    );
    const durableTypes = new Set([
      "turn.started",
      "message.completed",
      "tool.completed",
      "approval.required",
      "approval.resolved",
      "turn.completed",
      "turn.cancelled",
      "turn.failed",
      "capabilities.changed",
    ]);
    for (const event of events) {
      assert.equal(event.durability, durableTypes.has(event.event.type) ? "durable" : "ephemeral");
    }
    const replay = service.resumeEvents({
      threadId: threadIdSchema.parse(IDS.thread),
      afterCursor: null,
    });
    const durableEvents = events.filter((event) => event.durability === "durable");
    assert.equal(replay.replayedCount, durableEvents.length);
    assert.deepEqual(
      replay.events.map((event) => event.event.type),
      durableEvents.map((event) => event.event.type),
    );
    const replayedApproval = replay.events.find(
      (event) => event.event.type === "approval.required",
    );
    assert.ok(replayedApproval?.event.type === "approval.required");
    assert.equal(
      JSON.stringify(replayedApproval.event.approval.preview).includes(
        APPROVAL_PROVIDER_OPTIONS_SENTINEL,
      ),
      false,
    );
    const replayedTool = replay.events.find((event) => event.event.type === "tool.completed");
    assert.ok(replayedTool?.event.type === "tool.completed");
    assert.equal(
      JSON.stringify(replayedTool.event.display).includes(TOOL_PROVIDER_OPTIONS_SENTINEL),
      false,
    );
    assert.equal(
      replay.throughCursor,
      service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 100 })
        .eventCursor,
    );

    const renamed = await service.renameThread(
      runtimeMethodSchemas["thread.rename"].params.parse({
        requestId: IDS.requestRename,
        threadId: IDS.thread,
        title: "Renamed",
      }),
    );
    assert.equal(renamed.thread.title, "Renamed");
    const detachParams = runtimeMethodSchemas["thread.detach"].params.parse({
      requestId: IDS.requestDetach,
      threadId: IDS.thread,
    });
    assert.equal((await service.detachThread(detachParams)).detached, true);
    assert.equal((await service.detachThread(detachParams)).detached, true);
    const deleteParams = runtimeMethodSchemas["thread.delete"].params.parse({
      requestId: IDS.requestDelete,
      threadId: IDS.thread,
    });
    assert.equal((await service.deleteThread(deleteParams)).deleted, true);
    assert.equal((await service.deleteThread(deleteParams)).deleted, true);
    assert.equal(service.listThreads({ limit: 100 }).items.length, 0);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService snapshot reads append-only transcript and redacted Tool ledger", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store);
  try {
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: requestIdSchema.parse(IDS.requestCreate),
        title: "Snapshot",
      }),
    );
    store.appendMessages(IDS.thread, [
      { role: "user", content: "original user message" },
      { role: "assistant", content: "original assistant message" },
      { role: "user", content: "second user message" },
      { role: "assistant", content: "second assistant message" },
    ]);
    store.replaceMessages(IDS.thread, [{ role: "user", content: "compressed projection" }]);
    store.appendToolExecution(IDS.thread, execution());

    const snapshot = service.snapshotThread(
      runtimeMethodSchemas["thread.snapshot"].params.parse({
        threadId: threadIdSchema.parse(IDS.thread),
        limit: 2,
      }),
    );
    assert.deepEqual(
      snapshot.messages.items.map((message) => {
        const part = message.parts[0];
        return part?.type === "text" ? part.text : undefined;
      }),
      ["second user message", "second assistant message"],
    );
    assert.equal(snapshot.messages.nextBeforeSequence, 2);
    const previousPage = service.snapshotThread(
      runtimeMethodSchemas["thread.snapshot"].params.parse({
        threadId: IDS.thread,
        messageBeforeSequence: snapshot.messages.nextBeforeSequence,
        limit: 2,
      }),
    );
    assert.deepEqual(
      previousPage.messages.items.map((message) => {
        const part = message.parts[0];
        return part?.type === "text" ? part.text : undefined;
      }),
      ["original user message", "original assistant message"],
    );
    assert.equal(previousPage.messages.nextBeforeSequence, null);
    assert.equal(JSON.stringify(snapshot).includes("compressed projection"), false);
    assert.equal(snapshot.operations.items.length, 1);
    assert.deepEqual(snapshot.operations.items[0]?.outcome, {
      kind: "cancelled",
      reason: "user",
    });
    assert.equal("executionState" in (snapshot.operations.items[0]?.outcome ?? {}), false);
    assert.doesNotThrow(() =>
      parseRuntimeMethodResultForVersion("1.3", "thread.snapshot", {
        ...snapshot,
        pendingInteractions: [],
      }),
    );
    assert.equal(JSON.stringify(snapshot.operations.items).includes("secret-input"), false);
    assert.equal(JSON.stringify(snapshot.operations.items).includes("secret-raw"), false);
    assert.equal(snapshot.transcriptCompleteness, "complete");

    const operation = service.getOperation(
      runtimeMethodSchemas["operation.get"].params.parse({
        threadId: IDS.thread,
        operationId: IDS.operation,
      }),
    );
    assert.equal(operation.operation?.id, IDS.operation);
    assert.deepEqual(operation.operation?.outcome, {
      kind: "cancelled",
      reason: "user",
    });
    assert.equal("executionState" in (operation.operation?.outcome ?? {}), false);
    assert.doesNotThrow(() =>
      parseRuntimeMethodResultForVersion("1.3", "operation.get", operation),
    );
    assert.equal("raw" in (operation.operation ?? {}), false);
    assert.equal("input" in (operation.operation ?? {}), false);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService limit-one recovery Snapshot keeps large transcript pages frame-bounded", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store);
  try {
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: requestIdSchema.parse(IDS.requestCreate),
        title: "Large recovery Snapshot",
      }),
    );
    const text = "x".repeat(9 * 1_024 * 1_024);
    store.appendMessages(IDS.thread, [
      { role: "assistant", content: text },
      { role: "assistant", content: text },
    ]);

    const snapshot = service.snapshotThread(
      runtimeMethodSchemas["thread.snapshot"].params.parse({
        threadId: IDS.thread,
        limit: 1,
      }),
    );
    assert.equal(snapshot.messages.items.length, 1);
    const firstPart = snapshot.messages.items[0]?.parts[0];
    assert.ok(firstPart?.type === "text");
    assert.equal(firstPart.text.length, text.length);
    assert.equal(snapshot.messages.nextBeforeSequence, 1);
    assert.ok(
      Buffer.byteLength(JSON.stringify(snapshot), "utf8") < RUNTIME_V13_MIN_CLIENT_FRAME_BYTES,
    );
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService rejects unsupported protocol versions", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store);
  try {
    assert.throws(
      () =>
        service.initialize({
          protocolVersions: ["2.0"],
          client: { name: "future-client", version: "2.0.0" },
        }),
      /不支持客户端协议版本/u,
    );
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService 按客户端优先级协商 1.0/1.1", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store);
  try {
    assert.equal(
      service.initialize({
        protocolVersions: ["1.0", "1.1"],
        client: { name: "legacy-first", version: "1.0.0" },
      }).protocolVersion,
      "1.0",
    );
    assert.equal(
      service.initialize({
        protocolVersions: ["1.1", "1.0"],
        client: { name: "latest-first", version: "1.1.0" },
      }).protocolVersion,
      "1.1",
    );
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService 关闭后拒绝重新 initialize", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store);
  try {
    await service.close();
    assert.throws(
      () =>
        service.initialize({
          protocolVersions: ["1.1", "1.0"],
          client: { name: "late-client", version: "1.1.0" },
        }),
      (error: unknown) =>
        error instanceof RuntimeServiceError &&
        error.rollCode === "RUNTIME_CLOSING" &&
        error.retryable,
    );
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService projects waiting-for-user and settles user input exactly once", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const requestId = sessionUserInputRequestIdSchema.parse("00000000-0000-4000-8000-000000000130");
  const invalidRequestId = sessionUserInputRequestIdSchema.parse(
    "00000000-0000-4000-8000-000000000131",
  );
  const staleRequestId = sessionUserInputRequestIdSchema.parse(
    "00000000-0000-4000-8000-000000000132",
  );
  const submitted = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const staleCancelled = Promise.withResolvers<void>();
  const enabled: boolean[] = [];
  const cancellationReasons: string[] = [];
  let submittedPending = true;
  let invalidPending = true;
  let stalePending = true;
  let resolveCalls = 0;
  const form: UserInputForm = {
    title: "选择目标 Workspace",
    controls: [
      {
        type: "text",
        id: "workspace",
        label: "目标 Workspace",
        required: true,
        maxLength: 120,
      },
    ],
  };
  const session: RuntimeServiceSession = {
    id: IDS.thread,
    async *send() {
      yield { type: "message-start", messageId: IDS.message };
      yield {
        type: "user-input-required",
        requestId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        form,
      };
      await submitted.promise;
      yield { type: "user-input-settled", requestId, status: "submitted" };
      yield {
        type: "user-input-required",
        requestId: invalidRequestId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        form,
      };
      await cancelled.promise;
      yield { type: "user-input-settled", requestId: invalidRequestId, status: "cancelled" };
      yield {
        type: "user-input-required",
        requestId: staleRequestId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        form,
      };
      await staleCancelled.promise;
      yield { type: "user-input-settled", requestId: staleRequestId, status: "cancelled" };
      yield { type: "message-finish", text: "done" };
    },
    approve() {
      return false;
    },
    reject() {
      return false;
    },
    cancel() {
      return false;
    },
    async close() {},
    setUserInputAvailable(available) {
      enabled.push(available);
    },
    resolveUserInput(candidateRequestId) {
      if (candidateRequestId === staleRequestId) {
        resolveCalls += 1;
        return false;
      }
      if (!submittedPending || candidateRequestId !== requestId) {
        return false;
      }
      resolveCalls += 1;
      submittedPending = false;
      submitted.resolve();
      return true;
    },
    cancelUserInput(candidateRequestId, reason) {
      if (invalidPending && candidateRequestId === invalidRequestId) {
        invalidPending = false;
        cancellationReasons.push(reason ?? "");
        cancelled.resolve();
        return true;
      }
      if (stalePending && candidateRequestId === staleRequestId) {
        stalePending = false;
        cancellationReasons.push(reason ?? "");
        staleCancelled.resolve();
        return true;
      }
      return false;
    },
    getCapabilityManifest() {
      throw new Error("capabilities are not used by this fixture");
    },
    getCapabilityTurnContext() {
      return undefined;
    },
  };
  const engine: RuntimeServiceEngine = {
    async createSession() {
      store.createThread({ id: IDS.thread, model: "fixture-model" });
      return session;
    },
    async resumeSession() {
      return session;
    },
  };
  const service = new RuntimeService(engine, store);
  const interactions: RuntimeUserInputInteractionEvent[] = [];
  service.onUserInputInteraction((event) => interactions.push(event));
  try {
    service.setUserInputAvailable(true);
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
      }),
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestFirstTurn,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "需要 workspace" },
      }),
    );
    await nextTick();

    assert.deepEqual(enabled, [true]);
    assert.equal(
      service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 100 }).activeTurn
        ?.status,
      "waiting-for-user",
    );
    const required = interactions[0];
    assert.ok(required?.type === "required");
    assert.notEqual(required.form, form);
    assert.notEqual(required.form.controls[0], form.controls[0]);
    Object.assign(form.controls[0]!, { maxLength: 1 });
    assert.throws(() => Object.assign(required.form.controls[0]!, { maxLength: 2 }), TypeError);
    assert.equal(
      service.resolvePendingUserInput(requestId, {
        status: "submitted",
        values: [{ id: "workspace", value: "product-docs" }],
      }),
      true,
    );
    Object.assign(form.controls[0]!, { maxLength: 120 });
    assert.equal(
      service.resolvePendingUserInput(requestId, {
        status: "submitted",
        values: [{ id: "workspace", value: "late-duplicate" }],
      }),
      false,
    );
    await nextTick();
    assert.equal(
      service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 100 }).activeTurn
        ?.status,
      "waiting-for-user",
    );
    assert.equal(
      service.resolvePendingUserInput(invalidRequestId, {
        status: "submitted",
        values: [{ id: "workspace", value: true }],
      }),
      false,
    );
    assert.equal(resolveCalls, 1);
    assert.deepEqual(cancellationReasons, ["用户输入不符合原始表单约束"]);
    assert.equal(
      service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 100 }).activeTurn
        ?.status,
      "running",
    );
    const invalidSettled = interactions.find(
      (event) => event.type === "settled" && event.requestId === invalidRequestId,
    );
    assert.ok(invalidSettled?.type === "settled");
    assert.equal(invalidSettled.reason, "用户输入不符合原始表单约束");
    await nextTick();
    assert.equal(
      service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 100 }).activeTurn
        ?.status,
      "waiting-for-user",
    );
    assert.equal(
      service.resolvePendingUserInput(staleRequestId, {
        status: "submitted",
        values: [{ id: "workspace", value: "still-valid" }],
      }),
      false,
    );
    assert.equal(resolveCalls, 2);
    assert.deepEqual(cancellationReasons, ["用户输入不符合原始表单约束", "用户输入请求已失效"]);
    const staleSettled = interactions.find(
      (event) => event.type === "settled" && event.requestId === staleRequestId,
    );
    assert.ok(staleSettled?.type === "settled");
    assert.equal(staleSettled.reason, "用户输入请求已失效");
    await nextTick();
    assert.equal(interactions.filter((event) => event.type === "settled").length, 3);
    assert.equal(JSON.stringify(interactions).includes("product-docs"), false);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RuntimeService v1.4 附件生命周期：stage → turn.start 引用 → snapshot 安全元数据", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const attachmentStore = new AttachmentStore({ dir: join(tempDir(), "attachments") });
  const workDir = tempDir();
  const capturedInputs: unknown[] = [];
  const session: RuntimeServiceSession = {
    id: IDS.thread,
    async *send(input) {
      capturedInputs.push(input);
      const content =
        typeof input === "string"
          ? input
          : [
              ...(input.text.length > 0 ? [{ type: "text" as const, text: input.text }] : []),
              ...(input.attachments ?? []).map((attachment) => ({
                type: "file" as const,
                data: attachment.data,
                mediaType: attachment.mediaType,
              })),
            ];
      store.appendMessages(IDS.thread, [
        { role: "user", content },
        { role: "assistant", content: "看到了" },
      ]);
      yield { type: "message-start", messageId: IDS.message };
      yield { type: "message-finish", text: "看到了" };
    },
    approve() {
      return false;
    },
    reject() {
      return false;
    },
    cancel() {
      return false;
    },
    async close() {},
    getCapabilityManifest() {
      throw new Error("unused");
    },
    getCapabilityTurnContext() {
      return undefined;
    },
  };
  const engine: RuntimeServiceEngine = {
    async createSession(input) {
      store.createThread({
        id: IDS.thread,
        ...(input?.title !== undefined ? { title: input.title } : {}),
        model: "fixture-model",
      });
      return session;
    },
    async resumeSession() {
      return session;
    },
  };
  const service = new RuntimeService(engine, store, { attachmentStore });
  try {
    const initialized = service.initialize({
      protocolVersions: ["1.4"],
      client: { name: "test-client", version: "1.0.0" },
    });
    assert.equal(initialized.protocolVersion, "1.4");
    assert.ok(initialized.features.includes("attachments"));
    assert.ok("maxAttachmentBytes" in initialized.limits);
    assert.ok("maxTurnAttachments" in initialized.limits);

    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "附件会话",
      }),
    );

    const data = Buffer.from("png-bytes-for-vision-model");
    const sourcePath = join(workDir, "shot.png");
    writeFileSync(sourcePath, data);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const stageParams = runtimeMethodSchemas["attachment.stage"].params.parse({
      requestId: "00000000-0000-4000-8000-0000000000a1",
      threadId: IDS.thread,
      fileName: "shot.png",
      mediaType: "image/png",
      bytes: data.length,
      sha256,
      source: "local-path",
      sourcePath,
    });
    const staged = await service.stageAttachment(stageParams);
    assert.equal(staged.state, "committed");
    assert.equal(staged.descriptor?.displayName, "shot.png");

    const replay = await service.stageAttachment(stageParams);
    assert.equal(replay.attachmentId, staged.attachmentId);

    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: "00000000-0000-4000-8000-0000000000a2",
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "看下这张图", attachments: [staged.attachmentId] },
      }),
    );
    await nextTick();
    await nextTick();

    assert.equal(capturedInputs.length, 1);
    assert.deepEqual(capturedInputs[0], {
      text: "看下这张图",
      attachments: [{ data: data.toString("base64"), mediaType: "image/png" }],
    });

    const snapshot = service.snapshotThread({
      threadId: threadIdSchema.parse(IDS.thread),
      limit: 10,
    });
    const userMessage = snapshot.messages.items.find((message) => message.role === "user");
    assert.ok(userMessage);
    assert.deepEqual(userMessage.parts, [
      { type: "text", text: "看下这张图" },
      { type: "attachment", mediaType: "image/png", bytes: data.length },
    ]);
    assert.doesNotMatch(JSON.stringify(snapshot), /png-bytes-for-vision|base64|sourcePath/u);

    await assert.rejects(
      service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId: "00000000-0000-4000-8000-0000000000a3",
          threadId: IDS.thread,
          turnId: IDS.secondTurn,
          input: { text: "引用不存在附件", attachments: ["00000000-0000-4000-8000-0000000000ff"] },
        }),
      ),
      (error: unknown) =>
        error instanceof RuntimeServiceError && error.rollCode === "ATTACHMENT_NOT_FOUND",
    );

    const released = await service.releaseAttachment(
      runtimeMethodSchemas["attachment.release"].params.parse({
        requestId: "00000000-0000-4000-8000-0000000000a4",
        threadId: IDS.thread,
        attachmentId: staged.attachmentId,
      }),
    );
    assert.equal(released.released, true);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("RuntimeService 未配置附件存储时 attachments 能力关闭且方法拒绝", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  const service = new RuntimeService(fixture.engine, store, {});
  try {
    const initialized = service.initialize({
      protocolVersions: ["1.4"],
      client: { name: "test-client", version: "1.0.0" },
    });
    assert.equal(initialized.protocolVersion, "1.4");
    assert.equal(initialized.features.includes("attachments"), false);

    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: IDS.requestCreate,
        title: "无附件存储",
      }),
    );
    await assert.rejects(
      service.stageAttachment(
        runtimeMethodSchemas["attachment.stage"].params.parse({
          requestId: "00000000-0000-4000-8000-0000000000b1",
          threadId: IDS.thread,
          fileName: "x.png",
          mediaType: "image/png",
          bytes: 1,
          sha256: "0".repeat(64),
          source: "chunks",
        }),
      ),
      (error: unknown) =>
        error instanceof RuntimeServiceError && error.rollCode === "CAPABILITY_UNAVAILABLE",
    );
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
