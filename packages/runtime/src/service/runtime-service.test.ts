import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RUNTIME_PROTOCOL_VERSION,
  requestIdSchema,
  runtimeMethodSchemas,
  threadIdSchema,
  type RuntimeEventEnvelope,
} from "@roll-agent/protocol";
import { ThreadStore } from "../store/thread-store.ts";
import {
  createToolExecutionRecord,
  type ToolExecutionRecord,
} from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";
import {
  MutationRequestCache,
  RuntimeService,
  RuntimeServiceError,
  type RuntimeServiceEngine,
  type RuntimeServiceSession,
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
    result: successfulToolResult("visible", {
      raw: { token: "secret-raw" },
    }),
    createdAt: "2026-07-28T12:00:00.000Z",
  });
}

function createFixture(store: ThreadStore): {
  readonly engine: RuntimeServiceEngine;
  readonly session: RuntimeServiceSession;
  readonly sendCount: () => number;
} {
  let sends = 0;
  let resolveDecision: (() => void) | undefined;
  let cancelled = false;

  const session: RuntimeServiceSession = {
    id: IDS.thread,
    async *send(input) {
      sends += 1;
      cancelled = false;
      store.appendMessages(IDS.thread, [{ role: "user", content: input }]);
      yield { type: "message-start", messageId: IDS.message };
      yield {
        type: "confirmation-required",
        approvalId: IDS.approval,
        agentName: "demo-agent",
        toolName: "write",
        input: { path: "/tmp/demo", apiKey: "secret-preview" },
        reason: "requires approval",
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
      store.appendMessages(IDS.thread, [{ role: "assistant", content: "completed" }]);
      yield { type: "text-delta", delta: "completed" };
      yield { type: "message-finish", text: "completed" };
    },
    approve(approvalId) {
      if (approvalId !== IDS.approval || resolveDecision === undefined) {
        return false;
      }
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
  return { engine, session, sendCount: () => sends };
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
        { role: "user", content: input },
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

test("RuntimeService v1 supports lifecycle, concurrent approval/cancel and process-local dedupe", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
  const events: RuntimeEventEnvelope[] = [];
  service.onEvent((event) => events.push(event));
  try {
    const initialized = service.initialize({
      protocolVersions: [RUNTIME_PROTOCOL_VERSION],
      client: { name: "test-client", version: "1.0.0" },
    });
    assert.equal(initialized.protocolVersion, "1.0");
    assert.equal(initialized.limits.eventReplay, false);
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

    await service.respondApproval(
      runtimeMethodSchemas["approval.respond"].params.parse({
        requestId: IDS.requestApprove,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        approvalId: IDS.approval,
        decision: "approve",
      }),
    );
    await nextTick();
    assert.equal(
      events.some((event) => event.event.type === "turn.completed"),
      true,
    );

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
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_event, index) => index),
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
      snapshot.messages.items.map((message) => message.parts[0]?.text),
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
      previousPage.messages.items.map((message) => message.parts[0]?.text),
      ["original user message", "original assistant message"],
    );
    assert.equal(previousPage.messages.nextBeforeSequence, null);
    assert.equal(JSON.stringify(snapshot).includes("compressed projection"), false);
    assert.equal(snapshot.operations.items.length, 1);
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
    assert.equal("raw" in (operation.operation ?? {}), false);
    assert.equal("input" in (operation.operation ?? {}), false);
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
