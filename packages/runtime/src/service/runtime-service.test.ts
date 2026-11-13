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
  contextRecoveryViewSchema,
  getApprovalDiffPreview,
  getApprovalExplanation,
  getFileChangeDisplay,
  parseRuntimeMethodResultForVersion,
  requestIdSchema,
  turnIdSchema,
  runtimeMethodSchemas,
  threadIdSchema,
  type RuntimeEventEnvelopeV16,
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

for (const ending of ["approve", "cancel"] as const) {
  test(`model reload waits for approval and applies the newest request after ${ending}`, async () => {
    const dir = tempDir();
    const store = new ThreadStore(dir);
    const fixture = createFixture(store);
    let reloads = 0;
    const service = new RuntimeService(fixture.engine, store, {
      modelConfig: {
        initial: { provider: "original", model: "original-model" },
        reload: () => {
          reloads++;
          return { status: "applied", model: { provider: "next", model: "next-model" } };
        },
      },
    });
    try {
      await service.createThread({ requestId: requestIdSchema.parse(IDS.requestCreate) });
      await service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId: IDS.requestFirstTurn,
          threadId: IDS.thread,
          turnId: IDS.firstTurn,
          input: { text: "wait for approval" },
        }),
      );
      await nextTick();
      assert.equal(
        service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 100 })
          .pendingApprovals.length,
        1,
      );
      const first = await service.reloadModelConfig({
        requestId: requestIdSchema.parse(IDS.requestCacheFirst),
      });
      const last = await service.reloadModelConfig({
        requestId: requestIdSchema.parse(IDS.requestCacheSecond),
      });
      assert.equal(first.status, "pending");
      assert.equal(last.revision, 2);
      assert.equal(reloads, 0);
      assert.deepEqual(
        await service.reloadModelConfig({
          requestId: requestIdSchema.parse(IDS.requestCacheFirst),
        }),
        first,
      );
      if (ending === "approve") {
        await service.respondApproval(
          runtimeMethodSchemas["approval.respond"].params.parse({
            requestId: IDS.requestApprove,
            threadId: IDS.thread,
            turnId: IDS.firstTurn,
            approvalId: IDS.approval,
            decision: "approve",
          }),
        );
      } else {
        await service.cancelTurn(
          runtimeMethodSchemas["turn.cancel"].params.parse({
            requestId: IDS.requestCancel,
            threadId: IDS.thread,
            turnId: IDS.firstTurn,
          }),
        );
      }
      await nextTick();
      assert.equal(reloads, 1);
      assert.deepEqual(service.getModelConfig(), {
        status: "applied",
        revision: 2,
        active: { provider: "next", model: "next-model", revision: 2, reasoning: null },
      });
      assert.equal(fixture.sendCount(), 1);
    } finally {
      fixture.session.cancel();
      await service.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("model reload failures are redacted and a fresh request can recover", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  let reloads = 0;
  const service = new RuntimeService(fixture.engine, store, {
    modelConfig: {
      initial: { provider: "original", model: "original-model" },
      reload: () => {
        reloads++;
        if (reloads === 1) throw new Error("private-provider-credential-sentinel");
        return { status: "applied", model: { provider: "next", model: "next-model" } };
      },
    },
  });
  try {
    await service.createThread({ requestId: requestIdSchema.parse(IDS.requestCreate) });
    const failed = await service.reloadModelConfig({
      requestId: requestIdSchema.parse(IDS.requestCacheFirst),
    });
    assert.deepEqual(failed, {
      status: "failed",
      reason: "apply-failed",
      revision: 1,
      active: { provider: "original", model: "original-model", revision: 0, reasoning: null },
    });
    await assert.rejects(
      service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId: IDS.requestFirstTurn,
          threadId: IDS.thread,
          turnId: IDS.firstTurn,
          input: { text: "must wait" },
        }),
      ),
      (error: unknown) => error instanceof RuntimeServiceError && error.retryable,
    );
    assert.equal(fixture.sendCount(), 0);
    assert.deepEqual(
      await service.reloadModelConfig({ requestId: requestIdSchema.parse(IDS.requestCacheFirst) }),
      failed,
    );
    assert.equal(reloads, 1);
    assert.equal(
      (
        await service.reloadModelConfig({
          requestId: requestIdSchema.parse(IDS.requestCacheSecond),
        })
      ).status,
      "applied",
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestSecondTurn,
        threadId: IDS.thread,
        turnId: IDS.secondTurn,
        input: { text: "recovered" },
      }),
    );
    await nextTick();
    assert.equal(fixture.sendCount(), 1);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a model reload failure during turn admission prevents execution after session lookup", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  const service = new RuntimeService(fixture.engine, store, {
    modelConfig: {
      initial: { provider: "original", model: "original-model" },
      reload: () => ({ status: "failed", reason: "invalid-config" }),
    },
  });
  try {
    await service.createThread({ requestId: requestIdSchema.parse(IDS.requestCreate) });
    const starting = service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestFirstTurn,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "must not execute on the old model" },
      }),
    );
    const rejection = assert.rejects(
      starting,
      (error: unknown) =>
        error instanceof RuntimeServiceError && error.rollCode === "CAPABILITY_UNAVAILABLE",
    );
    assert.equal(
      (
        await service.reloadModelConfig({
          requestId: requestIdSchema.parse(IDS.requestCacheFirst),
        })
      ).status,
      "failed",
    );
    await rejection;
    await nextTick();
    assert.equal(fixture.sendCount(), 0);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async model preparation blocks admission until the host commits and updates reasoning", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  let resolvePreparation: (() => void) | undefined;
  const preparation = new Promise<void>((resolve) => {
    resolvePreparation = resolve;
  });
  const service = new RuntimeService(fixture.engine, store, {
    providerReasoning: "text",
    modelConfig: {
      initial: { provider: "original", model: "original-model" },
      async reload(signal) {
        await preparation;
        signal?.throwIfAborted();
        return {
          status: "applied",
          model: { provider: "next", model: "next-model" },
          reasoning: "summary",
        };
      },
    },
  });
  try {
    await service.createThread({ requestId: requestIdSchema.parse(IDS.requestCreate) });
    assert.equal(
      (await service.reloadModelConfig({ requestId: requestIdSchema.parse(IDS.requestCacheFirst) }))
        .status,
      "pending",
    );
    await assert.rejects(
      service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId: IDS.requestFirstTurn,
          threadId: IDS.thread,
          turnId: IDS.firstTurn,
          input: { text: "must wait for preparation" },
        }),
      ),
      (error: unknown) =>
        error instanceof RuntimeServiceError && error.rollCode === "CAPABILITY_UNAVAILABLE",
    );
    assert.equal(fixture.sendCount(), 0);
    resolvePreparation?.();
    await nextTick();
    assert.deepEqual(service.getModelConfig().active, {
      provider: "next",
      model: "next-model",
      revision: 1,
      reasoning: "summary",
    });
    assert.equal(
      service.subscribeReasoningText(() => {}),
      undefined,
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestSecondTurn,
        threadId: IDS.thread,
        turnId: IDS.secondTurn,
        input: { text: "prepared" },
      }),
    );
    await nextTick();
    assert.equal(fixture.sendCount(), 1);
  } finally {
    resolvePreparation?.();
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing a service aborts prepared model application before a late host commit", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  let resolvePreparation: (() => void) | undefined;
  const preparation = new Promise<void>((resolve) => {
    resolvePreparation = resolve;
  });
  let committed = false;
  const service = new RuntimeService(fixture.engine, store, {
    modelConfig: {
      initial: { provider: "original", model: "original-model" },
      async reload(signal) {
        await preparation;
        signal?.throwIfAborted();
        committed = true;
        return { status: "applied", model: { provider: "next", model: "next-model" } };
      },
    },
  });
  try {
    assert.equal(
      (await service.reloadModelConfig({ requestId: requestIdSchema.parse(IDS.requestCacheFirst) }))
        .status,
      "pending",
    );
    await service.close();
    resolvePreparation?.();
    await nextTick();
    assert.equal(committed, false);
  } finally {
    resolvePreparation?.();
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

function createFixture(
  store: ThreadStore,
  review?: { readonly text: string; readonly expiresAt: string },
): {
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
        type: "tool-input-activity",
        calls: [{ toolCallId: "ephemeral-generation-sentinel", name: "demo-agent.write" }],
      };
      yield { type: "tool-input-activity", calls: [] };
      yield { type: "model-step-start" };
      yield { type: "model-recovery", attempt: 1 };
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
        expiresAt: review?.expiresAt ?? "2026-07-28T12:05:00.000Z",
        ...(review !== undefined ? { fullDiff: review.text } : {}),
        reason: "requires approval",
        explanation: "写入用户请求的文件，以完成当前任务。",
        diff: {
          path: "demo",
          change: "modify",
          added: 1,
          removed: 1,
          hunks: 1,
          unified: "--- a/demo\n+++ b/demo\n@@ -1,1 +1,1 @@\n-old\n+new\n",
          truncated: false,
        },
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
          text: "visible",
          diff: {
            path: "demo",
            change: "modify",
            added: 1,
            removed: 1,
            hunks: 1,
            unified: "--- a/demo\n+++ b/demo\n@@ -1,1 +1,1 @@\n-x\n+y\n",
            truncated: false,
          },
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
  const events: RuntimeEventEnvelopeV16[] = [];
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

    const wire = store.resumeRuntimeEvents(IDS.thread, null);
    assert.doesNotMatch(
      JSON.stringify(wire),
      /ephemeral-generation-sentinel|tool-input-activity|model-step-start|model-recovery/,
    );
    assert.doesNotMatch(
      JSON.stringify(store.listTranscriptMessages(IDS.thread)),
      /ephemeral-generation-sentinel|tool-input-activity|model-step-start|model-recovery/,
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
  const events: RuntimeEventEnvelopeV16[] = [];
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
  const events: RuntimeEventEnvelopeV16[] = [];
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

function createMultiStreamFailureFixture(
  store: ThreadStore,
  terminal: "error" | "cancel",
): {
  readonly engine: RuntimeServiceEngine;
} {
  const session: RuntimeServiceSession = {
    id: IDS.thread,
    async *send(input) {
      store.appendMessages(IDS.thread, [
        { role: "user", content: typeof input === "string" ? input : input.text },
        { role: "assistant", content: "partial" },
      ]);
      yield { type: "message-start", messageId: IDS.message };
      yield { type: "text-delta", delta: "partial" };
      yield { type: "message-finish", text: "partial" };
      yield { type: "compaction-start", reason: "auto" };
      if (terminal === "error") {
        yield { type: "error", stage: "plan", message: "continuation failed" };
      } else {
        yield { type: "turn-cancelled", reason: "user", message: "用户取消本轮" };
      }
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
  return { engine };
}

for (const terminal of ["error", "cancel"] as const) {
  test(`RuntimeService 首段 message-finish 之后压缩阶段 ${terminal} 时以对应终态收尾,而不是沿用首段的 completed`, async () => {
    const dir = tempDir();
    const store = new ThreadStore(dir);
    const fixture = createMultiStreamFailureFixture(store, terminal);
    const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
    const events: RuntimeEventEnvelopeV16[] = [];
    service.onEvent((event) => events.push(event));
    try {
      service.initialize({
        protocolVersions: [RUNTIME_PROTOCOL_VERSION],
        client: { name: "multi-stream-failure-test", version: "1.0.0" },
      });
      await service.createThread(
        runtimeMethodSchemas["thread.create"].params.parse({
          requestId: IDS.requestCreate,
          title: "Multi stream failure",
        }),
      );
      await service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId: IDS.requestFirstTurn,
          threadId: IDS.thread,
          turnId: IDS.firstTurn,
          input: { text: "continue" },
        }),
      );
      await nextTick();

      const types = events.map((event) => event.event.type);
      assert.equal(types.filter((type) => type === "message.completed").length, 1);
      assert.equal(types.at(-1), terminal === "error" ? "turn.failed" : "turn.cancelled");
      assert.equal(types.includes("turn.completed"), false);
    } finally {
      await service.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const terminal of ["finish", "error", "cancel"] as const) {
  test(`RuntimeService pairs a stream across denied preparations and partial-text rebuilds: ${terminal}`, async () => {
    const dir = tempDir();
    const store = new ThreadStore(dir);
    const fixture = createFixture(store);
    Object.defineProperty(fixture.session, "send", {
      value: async function* () {
        yield { type: "message-start", messageId: IDS.message };
        yield { type: "compaction-start", reason: "auto" };
        yield { type: "message-start", messageId: IDS.message };
        yield { type: "text-delta", delta: "before " };
        yield { type: "message-start", messageId: IDS.message };
        yield { type: "text-delta", delta: "after" };
        if (terminal === "finish") yield { type: "message-finish", text: "after" };
        else if (terminal === "error") yield { type: "error", stage: "plan", message: "blocked" };
        else yield { type: "turn-cancelled", reason: "user", message: "cancelled" };
      },
    });
    const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
    const events: RuntimeEventEnvelopeV16[] = [];
    service.onEvent((event) => events.push(event));
    try {
      service.initialize({
        protocolVersions: [RUNTIME_PROTOCOL_VERSION],
        client: { name: "maintenance-stream", version: "1" },
      });
      await service.createThread(
        runtimeMethodSchemas["thread.create"].params.parse({ requestId: IDS.requestCreate }),
      );
      await service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId: IDS.requestFirstTurn,
          threadId: IDS.thread,
          turnId: IDS.firstTurn,
          input: { text: "continue" },
        }),
      );
      await nextTick();
      const starts = events.flatMap((e) => (e.event.type === "message.started" ? [e.event] : []));
      const finishes = events.flatMap((e) =>
        e.event.type === "message.completed" ? [e.event] : [],
      );
      assert.equal(starts.length, 1);
      assert.equal(finishes.length, 1);
      assert.equal(finishes[0]?.streamId, starts[0]?.streamId);
      assert.equal(finishes[0]?.text, "before after");
    } finally {
      await service.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("RuntimeService isolates event listeners before starting and completing a Turn", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createImmediateFixture(store);
  const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "0.9.0-test" });
  const eventsAfterThrow: RuntimeEventEnvelopeV16[] = [];
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
  const events: RuntimeEventEnvelopeV16[] = [];
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
  const events: RuntimeEventEnvelopeV16[] = [];
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
    await assert.rejects(service.close(), /blocked terminal runtime event insert/u);
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
  const events: RuntimeEventEnvelopeV16[] = [];
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
  const events: RuntimeEventEnvelopeV16[] = [];
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
    const previewDiff = getApprovalDiffPreview(approvalEvent.event.approval);
    assert.equal(previewDiff?.path, "demo");
    assert.equal(previewDiff?.added, 1);
    assert.match(previewDiff?.unified ?? "", /-old\n\+new/u);
    assert.equal(getApprovalDiffPreview(approvalSnapshot)?.removed, 1);

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
    const completedDisplay = getFileChangeDisplay(toolCompleted.event.display);
    assert.equal(completedDisplay?.text, "visible");
    assert.equal(completedDisplay?.diff.added, 1);
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

test("RuntimeService operation view keeps {text, diff} inside the persisted display envelope", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  const service = new RuntimeService(fixture.engine, store);
  try {
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({
        requestId: requestIdSchema.parse(IDS.requestCreate),
        title: "Diff operation",
      }),
    );
    const diff = {
      path: "a.txt",
      change: "modify",
      added: 1,
      removed: 1,
      hunks: 1,
      unified: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      truncated: false,
    } as const;
    store.appendToolExecution(
      IDS.thread,
      createToolExecutionRecord({
        id: IDS.operation,
        toolCallId: "call-diff",
        agentName: "roll",
        toolName: "edit_file",
        input: { file_path: "a.txt" },
        result: createToolResult(
          { kind: TOOL_OUTCOME_KINDS.success },
          { text: "已完成 1 处修改并写入 a.txt", diff },
          { model: { type: "text", value: "已完成 1 处修改并写入 a.txt" } },
        ),
        createdAt: "2026-08-19T12:00:00.000Z",
      }),
    );
    const snapshot = service.snapshotThread(
      runtimeMethodSchemas["thread.snapshot"].params.parse({
        threadId: threadIdSchema.parse(IDS.thread),
        limit: 10,
      }),
    );
    const operation = snapshot.operations.items[0];
    assert.ok(operation);
    assert.equal(getFileChangeDisplay(operation.display), undefined);
    const envelope = operation.display as { readonly value?: unknown };
    assert.deepEqual(getFileChangeDisplay(envelope.value), {
      text: "已完成 1 处修改并写入 a.txt",
      diff,
    });
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
      parseRuntimeMethodResultForVersion("1.6", "thread.snapshot", {
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
      parseRuntimeMethodResultForVersion("1.5", "operation.get", operation),
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

test("RuntimeService replays legacy recovery events while current snapshots have no gate", async () => {
  const dir = tempDir();
  let store = new ThreadStore(dir);
  const fixture = createFixture(store);
  Object.defineProperty(fixture.session, "send", {
    value: async function* () {
      // A legacy session fixture may still emit V1.6 events. They remain readable
      // and durable without recreating a ledger or enabling a current recovery gate.
      const legacyState = contextRecoveryViewSchema.parse({
        checkpointId: "00000000-0000-4000-8000-000000000201",
        required: true,
        unextracted: true,
        requiredItemCount: 2,
      });
      yield { type: "context-recovery", state: legacyState };
      yield { type: "context-recovery", state: { ...legacyState, required: false } };
      yield { type: "message-start", messageId: IDS.message };
      yield { type: "message-finish", text: "recovered" };
    },
  });
  let service = new RuntimeService(fixture.engine, store);
  const seen: RuntimeEventEnvelopeV16[] = [];
  const snapshots: unknown[] = [];
  service.onEvent((event) => {
    seen.push(event);
    if (event.event.type === "context.recovery.changed") {
      snapshots.push(
        service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 1 })
          .contextRecovery,
      );
    }
  });
  try {
    const initialized = service.initialize({
      protocolVersions: ["1.6"],
      client: { name: "recovery", version: "1" },
    });
    assert.equal(initialized.protocolVersion, "1.6");
    assert.ok(!initialized.features.includes("context-recovery"));
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({ requestId: IDS.requestCreate }),
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestFirstTurn,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "continue" },
      }),
    );
    await nextTick();
    assert.deepEqual(snapshots, [null, null]);
    const changes = seen.filter((event) => event.event.type === "context.recovery.changed");
    assert.equal(changes.length, 2);
    assert.ok(changes.every((event) => event.durability === "durable"));
    assert.doesNotMatch(JSON.stringify(changes), /MODEL_NOTES/);
    await service.close();
    store.close();
    store = new ThreadStore(dir);
    service = new RuntimeService(createFixture(store).engine, store);
    service.initialize({ protocolVersions: ["1.6"], client: { name: "reopened", version: "1" } });
    assert.equal(
      service.snapshotThread({ threadId: threadIdSchema.parse(IDS.thread), limit: 1 })
        .contextRecovery,
      null,
    );
    const replay = service.resumeEvents({
      threadId: threadIdSchema.parse(IDS.thread),
      afterCursor: null,
    });
    assert.deepEqual(
      replay.events
        .filter((entry) => entry.event.type === "context.recovery.changed")
        .map((entry) => entry.event),
      changes.map((entry) => entry.event),
    );
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("完整审批预览按页返回同一快照，不进入持久事件，审批结束即不可读", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fullDiff = `${"unchanged context\n".repeat(1000)}LAST_REVIEW_CHANGE\nAuthorization: Bearer approval-secret-value-123456789`;
  const fixture = createFixture(store, { text: fullDiff, expiresAt: "2099-01-01T00:00:00.000Z" });
  const service = new RuntimeService(fixture.engine, store, { runtimeVersion: "test" });
  try {
    service.initialize({
      protocolVersions: [RUNTIME_PROTOCOL_VERSION],
      client: { name: "review-test", version: "1" },
    });
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({ requestId: IDS.requestCreate }),
    );
    await service.startTurn(
      runtimeMethodSchemas["turn.start"].params.parse({
        requestId: IDS.requestFirstTurn,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        input: { text: "edit" },
      }),
    );
    await nextTick();
    const params = runtimeMethodSchemas["approval.preview"].params.parse({
      threadId: IDS.thread,
      turnId: IDS.firstTurn,
      approvalId: IDS.approval,
      maxChars: 17,
    });
    let offset: number | null = 0;
    let joined = "";
    while (offset !== null) {
      const page = service.getApprovalPreview({ ...params, offset });
      assert.ok(page.text.length <= 17);
      joined += page.text;
      offset = page.nextOffset;
    }
    assert.match(joined, /LAST_REVIEW_CHANGE/u);
    assert.doesNotMatch(joined, /approval-secret-value-123456789/u);
    assert.equal(service.getApprovalPreview(params).text, joined.slice(0, 17));
    const wire = JSON.stringify(store.resumeRuntimeEvents(IDS.thread, null));
    assert.match(wire, /fullDiffAvailable/u);
    assert.doesNotMatch(wire, /LAST_REVIEW_CHANGE/u);
    assert.throws(
      () => service.getApprovalPreview({ ...params, turnId: turnIdSchema.parse(IDS.secondTurn) }),
      /不存在或已失效/u,
    );
    await service.respondApproval(
      runtimeMethodSchemas["approval.respond"].params.parse({
        requestId: IDS.requestApprove,
        threadId: IDS.thread,
        turnId: IDS.firstTurn,
        approvalId: IDS.approval,
        decision: "reject",
      }),
    );
    assert.throws(() => service.getApprovalPreview(params), /不存在或已失效/u);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const source of ["summary", "text", "legacy"] as const) {
  const mode = source === "legacy" ? "summary" : source;
  test(`RuntimeService isolates ${source} from raw deltas, public observers and replay`, async () => {
    const dir = tempDir();
    const store = new ThreadStore(dir);
    const fixture = createFixture(store);
    fixture.session.send = async function* () {
      yield { type: "reasoning-delta", reasoningId: "r", delta: "unclassified" };
      yield { type: "reasoning-delta", reasoningId: "r", presentation: mode, delta: "Inspect " };
      yield { type: "reasoning-delta", reasoningId: "r", presentation: mode, delta: "Bea" };
      yield {
        type: "reasoning-delta",
        reasoningId: "r",
        presentation: mode,
        delta: "rer fixture-only",
      };
      if (source !== "legacy") yield { type: "reasoning-end", reasoningId: "r" };
      yield { type: "message-finish", text: "answer" };
    };
    const service = new RuntimeService(
      fixture.engine,
      store,
      source === "legacy"
        ? { reasoningSummaryProjector: (delta) => (delta === "unclassified" ? undefined : delta) }
        : { providerReasoning: mode },
    );
    const publicEvents: RuntimeEventEnvelopeV16[] = [];
    const privateEvents: RuntimeEventEnvelopeV16[] = [];
    service.onEvent((event) => publicEvents.push(event));
    try {
      const handshake = service.initialize({
        protocolVersions: ["1.6"],
        client: { name: "display-test", version: "1" },
      });
      assert.equal(handshake.features.includes("reasoning-summary"), mode === "summary");
      const unsubscribe = service.subscribeReasoningText((event) => privateEvents.push(event));
      assert.equal(unsubscribe !== undefined, mode === "text");
      assert.equal(
        service.subscribeReasoningText(() => assert.fail("second subscriber")),
        undefined,
      );
      await service.createThread(
        runtimeMethodSchemas["thread.create"].params.parse({ requestId: IDS.requestCreate }),
      );
      await service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId: IDS.requestFirstTurn,
          threadId: IDS.thread,
          turnId: IDS.firstTurn,
          input: { text: "check" },
        }),
      );
      await nextTick();
      const displayed = (mode === "text" ? privateEvents : publicEvents)
        .flatMap(({ event }) =>
          event.type === `reasoning.${mode}.delta` && "delta" in event ? [event.delta] : [],
        )
        .join("");
      assert.equal(displayed, "Inspect Bearer [redacted]");
      assert.ok(publicEvents.every(({ event }) => event.type !== "reasoning.text.delta"));
      assert.doesNotMatch(
        JSON.stringify([...publicEvents, ...privateEvents]),
        /unclassified|fixture-only/u,
      );
      assert.doesNotMatch(
        JSON.stringify(store.resumeRuntimeEvents(IDS.thread, null)),
        /reasoning\.(text|summary)|Inspect Bearer/u,
      );
      unsubscribe?.();
    } finally {
      await service.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("private text belongs to the original subscription, even when a callback is reused", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const fixture = createFixture(store);
  fixture.session.send = async function* () {
    for (const delta of ["first ", "tail"]) {
      yield { type: "reasoning-delta", presentation: "text", reasoningId: "r", delta };
    }
    yield { type: "reasoning-end", reasoningId: "r" };
    yield { type: "message-finish", text: "answer" };
  };
  const service = new RuntimeService(fixture.engine, store, { providerReasoning: "text" });
  const seen: string[] = [];
  function receive({ event }: RuntimeEventEnvelopeV16) {
    assert.equal(event.type, "reasoning.text.delta");
    seen.push(event.delta);
    if (seen.length === 1) {
      original?.();
      service.subscribeReasoningText(receive);
      original?.(); // Stale cleanup must not remove the replacement subscription.
    }
  }
  const original = service.subscribeReasoningText(receive);
  try {
    await service.createThread(
      runtimeMethodSchemas["thread.create"].params.parse({ requestId: IDS.requestCreate }),
    );
    for (const [turnId, requestId] of [
      [IDS.firstTurn, IDS.requestFirstTurn],
      [IDS.secondTurn, IDS.requestSecondTurn],
    ]) {
      await service.startTurn(
        runtimeMethodSchemas["turn.start"].params.parse({
          requestId,
          turnId,
          threadId: IDS.thread,
          input: { text: "check" },
        }),
      );
      await nextTick();
    }
    assert.deepEqual(seen, ["first ", "first ", "tail"]);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function mergeClientSnapshotTimeline(
  snapshot: ReturnType<RuntimeService["snapshotThread"]>,
): string[] {
  const rows: Array<{
    readonly label: string;
    readonly at: string;
    readonly order: number;
  }> = [
    ...snapshot.messages.items.map((message) => {
      const textPart = message.parts.find((part) => part.type === "text");
      return {
        label: `${message.role}:${textPart?.text ?? ""}`,
        at: message.createdAt,
        order: -1,
      };
    }),
    ...snapshot.operations.items.map((operation) => ({
      label: `tool:${operation.toolCallId}:${operation.toolName}`,
      at: operation.createdAt,
      order: operation.sequence,
    })),
  ];
  return rows
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.order - right.order)
    .map((row) => row.label);
}

test("snapshotThread 在可写与只读历史浏览下将存量回合末统一盖戳消息对齐回真实工具因果穿插顺序", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  let storeClosed = false;
  try {
    const baseMs = Date.now() - 120_000;
    const at = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();
    const threadId = store.createThread({ id: IDS.thread, title: "legacy-interleaved" });
    store.appendMessages(threadId, [{ role: "user", content: "排查服务故障" }], {
      messageCreatedAt: [at(0)],
    });

    const op1 = createToolExecutionRecord({
      toolCallId: "call_1",
      agentName: "shell",
      toolName: "check_port",
      input: { port: 3000 },
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "port 3000 closed"),
      createdAt: at(2_000),
    });
    const op2 = createToolExecutionRecord({
      toolCallId: "call_2",
      agentName: "shell",
      toolName: "read_logs",
      input: { lines: 50 },
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "EADDRINUSE"),
      createdAt: at(5_000),
    });
    // 故意让最后一个工具与整轮落盘处于同一毫秒（+10_000ms），检验总结消息不会因 order=-1 排到工具前面
    const op3 = createToolExecutionRecord({
      toolCallId: "call_3",
      agentName: "shell",
      toolName: "check_pid",
      input: { pid: 1234 },
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "alive"),
      createdAt: at(10_000),
    });
    store.appendToolExecution(threadId, op1);
    store.appendToolExecution(threadId, op2);
    store.appendToolExecution(threadId, op3);

    // 模拟历史存量数据：整轮所有 assistant / tool 消息共享回合末同一个提交时间戳
    const legacyBatchCommitAt = at(10_000);
    store.appendMessages(
      threadId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "我先检查 3000 端口状态。" },
            { type: "tool-call", toolCallId: "call_1", toolName: "shell__check_port", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "shell__check_port",
              output: { type: "text", value: "port 3000 closed" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "端口未监听，我再同时读取日志并核对进程。" },
            { type: "tool-call", toolCallId: "call_2", toolName: "shell__read_logs", input: {} },
            { type: "tool-call", toolCallId: "call_3", toolName: "shell__check_pid", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_2",
              toolName: "shell__read_logs",
              output: { type: "text", value: "EADDRINUSE" },
            },
            {
              type: "tool-result",
              toolCallId: "call_3",
              toolName: "shell__check_pid",
              output: { type: "text", value: "alive" },
            },
          ],
        },
        {
          role: "assistant",
          content: "定位完成：旧进程 1234 占用了端口导致重启失败。",
        },
      ],
      {
        messageCreatedAt: Array.from({ length: 5 }, () => legacyBatchCommitAt),
        toolExecutionCoverage: {
          executionIds: [op1.id, op2.id, op3.id],
          representation: "raw_transcript",
        },
      },
    );

    const expectedOrder = [
      "user:排查服务故障",
      "assistant:我先检查 3000 端口状态。",
      "tool:call_1:check_port",
      "assistant:端口未监听，我再同时读取日志并核对进程。",
      "tool:call_2:read_logs",
      "tool:call_3:check_pid",
      "assistant:定位完成：旧进程 1234 占用了端口导致重启失败。",
    ];

    const writableService = new RuntimeService(createFixture(store).engine, store);
    try {
      const snapshot = writableService.snapshotThread({
        threadId: threadIdSchema.parse(IDS.thread),
        limit: 100,
      });
      assert.doesNotThrow(() =>
        parseRuntimeMethodResultForVersion("1.6", "thread.snapshot", {
          ...snapshot,
          pendingInteractions: [],
        }),
      );
      assert.equal(snapshot.messages.items.length, 4);
      assert.deepEqual(mergeClientSnapshotTimeline(snapshot), expectedOrder);
    } finally {
      await writableService.close();
    }
    store.close();
    storeClosed = true;

    const readOnlyStore = new ThreadStore(dir, { readOnly: true });
    const inertEngine: RuntimeServiceEngine = {
      createSession: async () => {
        throw new Error("unexpected createSession");
      },
      resumeSession: async () => {
        throw new Error("unexpected resumeSession");
      },
    };
    const readOnlyService = new RuntimeService(inertEngine, readOnlyStore);
    try {
      const readOnlySnapshot = readOnlyService.snapshotThread({
        threadId: threadIdSchema.parse(IDS.thread),
        limit: 100,
      });
      assert.deepEqual(mergeClientSnapshotTimeline(readOnlySnapshot), expectedOrder);
    } finally {
      await readOnlyService.close();
      readOnlyStore.close();
    }
  } finally {
    if (!storeClosed) {
      store.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotThread 在跨轮复用相同 toolCallId 及旧工具缺失时依靠 coverage 边界保持因果不串轮", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const service = new RuntimeService(createFixture(store).engine, store);
  try {
    const baseMs = Date.now() - 120_000;
    const at = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();
    const threadId = store.createThread({ id: IDS.thread, title: "duplicate-call-ids" });

    // 第一轮：call_1（假设其工具记录后来被淘汰/清理，后面还有同批 call_2 存活）
    const turn1KeptTool = createToolExecutionRecord({
      toolCallId: "call_2",
      agentName: "fs",
      toolName: "read_b",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "b"),
      createdAt: at(4_000),
    });
    store.appendMessages(threadId, [{ role: "user", content: "第一轮问题" }], {
      messageCreatedAt: [at(0)],
    });
    store.appendToolExecution(threadId, turn1KeptTool);
    store.appendMessages(
      threadId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "第一轮先调已过期的 call_1。" },
            { type: "tool-call", toolCallId: "call_1", toolName: "fs__read_a", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "fs__read_a",
              output: { type: "text", value: "a" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "第一轮再调仍在保留期的 call_2。" },
            { type: "tool-call", toolCallId: "call_2", toolName: "fs__read_b", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_2",
              toolName: "fs__read_b",
              output: { type: "text", value: "b" },
            },
          ],
        },
        { role: "assistant", content: "第一轮总结。" },
      ],
      {
        messageCreatedAt: Array.from({ length: 5 }, () => at(8_000)),
        toolExecutionCoverage: {
          executionIds: [turn1KeptTool.id],
          representation: "raw_transcript",
        },
      },
    );

    // 第二轮：兼容模型再次复用同名 toolCallId "call_1"
    const turn2Tool = createToolExecutionRecord({
      toolCallId: "call_1",
      agentName: "fs",
      toolName: "read_c",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "c"),
      createdAt: at(62_000),
    });
    store.appendMessages(threadId, [{ role: "user", content: "第二轮问题" }], {
      messageCreatedAt: [at(60_000)],
    });
    store.appendToolExecution(threadId, turn2Tool);
    store.appendMessages(
      threadId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "第二轮复用 call_1。" },
            { type: "tool-call", toolCallId: "call_1", toolName: "fs__read_c", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "fs__read_c",
              output: { type: "text", value: "c" },
            },
          ],
        },
        { role: "assistant", content: "第二轮总结。" },
      ],
      {
        messageCreatedAt: Array.from({ length: 3 }, () => at(65_000)),
        toolExecutionCoverage: {
          executionIds: [turn2Tool.id],
          representation: "raw_transcript",
        },
      },
    );

    const snapshot = service.snapshotThread({
      threadId: threadIdSchema.parse(IDS.thread),
      limit: 100,
    });
    assert.deepEqual(mergeClientSnapshotTimeline(snapshot), [
      "user:第一轮问题",
      "assistant:第一轮先调已过期的 call_1。",
      "assistant:第一轮再调仍在保留期的 call_2。",
      "tool:call_2:read_b",
      "assistant:第一轮总结。",
      "user:第二轮问题",
      "assistant:第二轮复用 call_1。",
      "tool:call_1:read_c",
      "assistant:第二轮总结。",
    ]);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotThread 对静默无文本工具步骤与分页截断在 tool 消息处的末尾总结仍严格晚于工具", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const service = new RuntimeService(createFixture(store).engine, store);
  try {
    const baseMs = Date.now() - 120_000;
    const at = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();
    const threadId = store.createThread({ id: IDS.thread, title: "silent-tool-and-page-cut" });

    store.appendMessages(threadId, [{ role: "user", content: "检查配置" }], {
      messageCreatedAt: [at(0)],
    });
    const op1 = createToolExecutionRecord({
      toolCallId: "call_1",
      agentName: "fs",
      toolName: "read_a",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "a"),
      createdAt: at(2_000),
    });
    // 第二步是无文本的静默工具调用，且与整轮提交处于同一毫秒（+5_000ms）
    const opSilent = createToolExecutionRecord({
      toolCallId: "call_silent",
      agentName: "fs",
      toolName: "read_b",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "b"),
      createdAt: at(5_000),
    });
    store.appendToolExecution(threadId, op1);
    store.appendToolExecution(threadId, opSilent);
    store.appendMessages(
      threadId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "我先读取配置 A。" },
            { type: "tool-call", toolCallId: "call_1", toolName: "fs__read_a", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "fs__read_a",
              output: { type: "text", value: "a" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call_silent", toolName: "fs__read_b", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_silent",
              toolName: "fs__read_b",
              output: { type: "text", value: "b" },
            },
          ],
        },
        { role: "assistant", content: "两份配置均已核对无误。" },
      ],
      {
        messageCreatedAt: Array.from({ length: 5 }, () => at(5_000)),
        toolExecutionCoverage: {
          executionIds: [op1.id, opSilent.id],
          representation: "raw_transcript",
        },
      },
    );

    const fullSnapshot = service.snapshotThread({
      threadId: threadIdSchema.parse(IDS.thread),
      limit: 100,
    });
    assert.deepEqual(mergeClientSnapshotTimeline(fullSnapshot), [
      "user:检查配置",
      "assistant:我先读取配置 A。",
      "tool:call_1:read_a",
      "assistant:",
      "tool:call_silent:read_b",
      "assistant:两份配置均已核对无误。",
    ]);

    // 分页截断边界：limit=2 时 transcript 页面只含 [tool(call_silent), assistant(总结)]，总结仍须排在 call_silent 之后
    const tailPageSnapshot = service.snapshotThread({
      threadId: threadIdSchema.parse(IDS.thread),
      limit: 2,
    });
    assert.deepEqual(mergeClientSnapshotTimeline(tailPageSnapshot), [
      "tool:call_1:read_a",
      "tool:call_silent:read_b",
      "assistant:两份配置均已核对无误。",
    ]);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotThread 在跨轮复用同一 toolCallId 且分页切在下一轮 user 之前时不会借用下一轮工具时间", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const service = new RuntimeService(createFixture(store).engine, store);
  try {
    const baseMs = Date.now() - 180_000;
    const at = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();
    const threadId = store.createThread({ id: IDS.thread, title: "cross-turn-dup-call-id-page" });

    // 第一轮（seq 0..3）：工具在 +2_000ms 完成，整轮响应在 +3_000ms 持久化
    store.appendMessages(threadId, [{ role: "user", content: "第一轮问题" }], {
      messageCreatedAt: [at(0)],
    });
    const turn1Tool = createToolExecutionRecord({
      toolCallId: "call_dup",
      agentName: "fs",
      toolName: "read_turn1",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "v1"),
      createdAt: at(2_000),
    });
    store.appendToolExecution(threadId, turn1Tool);
    store.appendMessages(
      threadId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "第一轮先读文件。" },
            { type: "tool-call", toolCallId: "call_dup", toolName: "fs__read_turn1", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_dup",
              toolName: "fs__read_turn1",
              output: { type: "text", value: "v1" },
            },
          ],
        },
        { role: "assistant", content: "第一轮总结。" },
      ],
      {
        messageCreatedAt: [at(3_000), at(3_000), at(3_000)],
        toolExecutionCoverage: {
          executionIds: [turn1Tool.id],
          representation: "raw_transcript",
        },
      },
    );

    // 第二轮（seq 4..7）：复用同一 toolCallId="call_dup"，工具在 +62_000ms 完成
    store.appendMessages(threadId, [{ role: "user", content: "第二轮问题" }], {
      messageCreatedAt: [at(60_000)],
    });
    const turn2Tool = createToolExecutionRecord({
      toolCallId: "call_dup",
      agentName: "fs",
      toolName: "read_turn2",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "v2"),
      createdAt: at(62_000),
    });
    store.appendToolExecution(threadId, turn2Tool);
    store.appendMessages(
      threadId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "第二轮再读文件。" },
            { type: "tool-call", toolCallId: "call_dup", toolName: "fs__read_turn2", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_dup",
              toolName: "fs__read_turn2",
              output: { type: "text", value: "v2" },
            },
          ],
        },
        { role: "assistant", content: "第二轮总结。" },
      ],
      {
        messageCreatedAt: [at(63_000), at(63_000), at(63_000)],
        toolExecutionCoverage: {
          executionIds: [turn2Tool.id],
          representation: "raw_transcript",
        },
      },
    );

    const fullSnapshot = service.snapshotThread({
      threadId: threadIdSchema.parse(IDS.thread),
      limit: 100,
    });
    const turn1SummaryFull = fullSnapshot.messages.items.find((item) => item.sequence === 3);
    assert.equal(turn1SummaryFull?.createdAt, at(3_000));

    // 关键边界：页面仅含第一轮 seq 0..3（下一轮 user seq=4 不在当前页内）
    const turn1Page = service.snapshotThread({
      threadId: threadIdSchema.parse(IDS.thread),
      limit: 4,
      messageBeforeSequence: 4,
    });
    assert.deepEqual(
      turn1Page.messages.items,
      fullSnapshot.messages.items.filter((item) => item.sequence < 4),
    );
    const turn1SummaryPaged = turn1Page.messages.items.find((item) => item.sequence === 3);
    assert.equal(turn1SummaryPaged?.createdAt, at(3_000));
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotThread 在同一轮内复用同一 toolCallId（含前序记录已过期裁剪）时 call/result 共享配对且不串位", async () => {
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const service = new RuntimeService(createFixture(store).engine, store);
  try {
    const baseMs = Date.now() - 180_000;
    const at = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();

    // 线程 1：同轮两次调用同一 toolCallId="call_repeat"，两条工具记录均存活
    const bothAliveId = store.createThread({ id: IDS.thread, title: "same-turn-repeat-alive" });
    store.appendMessages(bothAliveId, [{ role: "user", content: "检查两次" }], {
      messageCreatedAt: [at(0)],
    });
    const step1Op = createToolExecutionRecord({
      toolCallId: "call_repeat",
      agentName: "fs",
      toolName: "step_one",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "one"),
      createdAt: at(1_000),
    });
    const step2Op = createToolExecutionRecord({
      toolCallId: "call_repeat",
      agentName: "fs",
      toolName: "step_two",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "two"),
      createdAt: at(5_000),
    });
    store.appendToolExecution(bothAliveId, step1Op);
    store.appendToolExecution(bothAliveId, step2Op);
    store.appendMessages(
      bothAliveId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "第一次检查。" },
            { type: "tool-call", toolCallId: "call_repeat", toolName: "fs__step_one", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_repeat",
              toolName: "fs__step_one",
              output: { type: "text", value: "one" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "第二次检查。" },
            { type: "tool-call", toolCallId: "call_repeat", toolName: "fs__step_two", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_repeat",
              toolName: "fs__step_two",
              output: { type: "text", value: "two" },
            },
          ],
        },
        { role: "assistant", content: "两次检查总结。" },
      ],
      {
        messageCreatedAt: Array.from({ length: 5 }, () => at(5_000)),
        toolExecutionCoverage: {
          executionIds: [step1Op.id, step2Op.id],
          representation: "raw_transcript",
        },
      },
    );

    const bothAliveSnapshot = service.snapshotThread({
      threadId: threadIdSchema.parse(IDS.thread),
      limit: 100,
    });
    assert.deepEqual(
      bothAliveSnapshot.messages.items.map((item) => [item.sequence, item.createdAt]),
      [
        [0, at(0)],
        [1, at(1_000)],
        [3, at(5_000)],
        [5, at(5_001)],
      ],
    );
    assert.deepEqual(mergeClientSnapshotTimeline(bothAliveSnapshot), [
      "user:检查两次",
      "assistant:第一次检查。",
      "tool:call_repeat:step_one",
      "assistant:第二次检查。",
      "tool:call_repeat:step_two",
      "assistant:两次检查总结。",
    ]);

    // 线程 2：同轮两次调用同一 toolCallId="call_repeat"，但第一次记录已因 TTL 裁剪缺失，仅剩第二次记录
    const prunedFirstId = store.createThread({ title: "same-turn-repeat-pruned-first" });
    store.appendMessages(prunedFirstId, [{ role: "user", content: "重试检查" }], {
      messageCreatedAt: [at(10_000)],
    });
    const survivingSecondOp = createToolExecutionRecord({
      toolCallId: "call_repeat",
      agentName: "fs",
      toolName: "step_two_only",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "two"),
      createdAt: at(14_000),
    });
    store.appendToolExecution(prunedFirstId, survivingSecondOp);
    store.appendMessages(
      prunedFirstId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "早先已裁剪的第一次调用。" },
            {
              type: "tool-call",
              toolCallId: "call_repeat",
              toolName: "fs__step_one_pruned",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_repeat",
              toolName: "fs__step_one_pruned",
              output: { type: "text", value: "one" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "仍在保留期的第二次调用。" },
            {
              type: "tool-call",
              toolCallId: "call_repeat",
              toolName: "fs__step_two_only",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_repeat",
              toolName: "fs__step_two_only",
              output: { type: "text", value: "two" },
            },
          ],
        },
        { role: "assistant", content: "裁剪后总结。" },
      ],
      {
        messageCreatedAt: Array.from({ length: 5 }, () => at(14_000)),
        toolExecutionCoverage: {
          executionIds: [survivingSecondOp.id],
          representation: "raw_transcript",
        },
      },
    );

    const prunedSnapshot = service.snapshotThread({
      threadId: threadIdSchema.parse(prunedFirstId),
      limit: 100,
    });
    assert.deepEqual(mergeClientSnapshotTimeline(prunedSnapshot), [
      "user:重试检查",
      "assistant:早先已裁剪的第一次调用。",
      "assistant:仍在保留期的第二次调用。",
      "tool:call_repeat:step_two_only",
      "assistant:裁剪后总结。",
    ]);

    // 线程 3：前导未闭合 dangling call 后紧跟同 ID 逐 step 落盘调用，随后还有一次无账本的同 ID 调用
    const stepScopedId = store.createThread({ title: "same-turn-dangling-and-step-scoped" });
    store.appendMessages(
      stepScopedId,
      [
        { role: "user", content: "混合异常历史" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "未执行的悬空调用。" },
            { type: "tool-call", toolCallId: "call_repeat", toolName: "fs__dangling", input: {} },
          ],
        },
      ],
      {
        messageCreatedAt: [at(20_000), at(20_500)],
      },
    );
    const stepScopedOp = createToolExecutionRecord({
      toolCallId: "call_repeat",
      agentName: "fs",
      toolName: "recorded_step",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "recorded"),
      createdAt: at(22_000),
    });
    store.appendToolExecution(stepScopedId, stepScopedOp);
    store.appendMessages(
      stepScopedId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "已记账的调用。" },
            {
              type: "tool-call",
              toolCallId: "call_repeat",
              toolName: "fs__recorded_step",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_repeat",
              toolName: "fs__recorded_step",
              output: { type: "text", value: "recorded" },
            },
          ],
        },
      ],
      {
        messageCreatedAt: [at(22_000), at(22_000)],
        toolExecutionCoverage: {
          executionIds: [stepScopedOp.id],
          representation: "raw_transcript",
        },
      },
    );
    store.appendMessages(
      stepScopedId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "未写工具账本的内建调用。" },
            { type: "tool-call", toolCallId: "call_repeat", toolName: "roll__skill", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_repeat",
              toolName: "roll__skill",
              output: { type: "text", value: "skill-doc" },
            },
          ],
        },
        { role: "assistant", content: "混合异常总结。" },
      ],
      {
        messageCreatedAt: [at(22_000), at(22_000), at(22_000)],
      },
    );

    const stepScopedSnapshot = service.snapshotThread({
      threadId: threadIdSchema.parse(stepScopedId),
      limit: 100,
    });
    assert.deepEqual(mergeClientSnapshotTimeline(stepScopedSnapshot), [
      "user:混合异常历史",
      "assistant:未执行的悬空调用。",
      "assistant:已记账的调用。",
      "tool:call_repeat:recorded_step",
      "assistant:未写工具账本的内建调用。",
      "assistant:混合异常总结。",
    ]);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotThread 在任意分页步长（含 limit=1 仅总结页与只读存储）下保持严格分页不变性", async () => {
  const dir = tempDir();
  const writableStore = new ThreadStore(dir);
  let writableClosed = false;
  try {
    const baseMs = Date.now() - 240_000;
    const at = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();
    const threadId = writableStore.createThread({
      id: IDS.thread,
      title: "pagination-invariance",
    });

    // 第 1 轮：多步（普通工具 + 静默工具 + 同毫秒总结）
    writableStore.appendMessages(threadId, [{ role: "user", content: "轮次一" }], {
      messageCreatedAt: [at(0)],
    });
    const t1Op1 = createToolExecutionRecord({
      toolCallId: "shared_id",
      agentName: "fs",
      toolName: "t1_op1",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "ok"),
      createdAt: at(1_000),
    });
    const t1Op2 = createToolExecutionRecord({
      toolCallId: "silent_id",
      agentName: "fs",
      toolName: "t1_op2",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "ok"),
      createdAt: at(3_000),
    });
    writableStore.appendToolExecution(threadId, t1Op1);
    writableStore.appendToolExecution(threadId, t1Op2);
    writableStore.appendMessages(
      threadId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "轮次一步骤一" },
            { type: "tool-call", toolCallId: "shared_id", toolName: "fs__t1_op1", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "shared_id",
              toolName: "fs__t1_op1",
              output: { type: "text", value: "ok" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "silent_id", toolName: "fs__t1_op2", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "silent_id",
              toolName: "fs__t1_op2",
              output: { type: "text", value: "ok" },
            },
          ],
        },
        { role: "assistant", content: "轮次一同毫秒总结" },
      ],
      {
        messageCreatedAt: Array.from({ length: 5 }, () => at(3_000)),
        toolExecutionCoverage: {
          executionIds: [t1Op1.id, t1Op2.id],
          representation: "raw_transcript",
        },
      },
    );

    // 第 2 轮：纯文本对话（无工具）
    writableStore.appendMessages(
      threadId,
      [
        { role: "user", content: "轮次二纯文本" },
        { role: "assistant", content: "轮次二直接回复" },
      ],
      {
        messageCreatedAt: [at(20_000), at(21_000)],
      },
    );

    // 第 3 轮：跨轮复用 shared_id 且同轮连续调用两次 shared_id，末尾同毫秒总结
    writableStore.appendMessages(threadId, [{ role: "user", content: "轮次三" }], {
      messageCreatedAt: [at(40_000)],
    });
    const t3Op1 = createToolExecutionRecord({
      toolCallId: "shared_id",
      agentName: "fs",
      toolName: "t3_op1",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "ok1"),
      createdAt: at(42_000),
    });
    const t3Op2 = createToolExecutionRecord({
      toolCallId: "shared_id",
      agentName: "fs",
      toolName: "t3_op2",
      input: {},
      result: createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "ok2"),
      createdAt: at(45_000),
    });
    writableStore.appendToolExecution(threadId, t3Op1);
    writableStore.appendToolExecution(threadId, t3Op2);
    writableStore.appendMessages(
      threadId,
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "轮次三第一次调 shared_id" },
            { type: "tool-call", toolCallId: "shared_id", toolName: "fs__t3_op1", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "shared_id",
              toolName: "fs__t3_op1",
              output: { type: "text", value: "ok1" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "轮次三第二次调 shared_id" },
            { type: "tool-call", toolCallId: "shared_id", toolName: "fs__t3_op2", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "shared_id",
              toolName: "fs__t3_op2",
              output: { type: "text", value: "ok2" },
            },
          ],
        },
        { role: "assistant", content: "轮次三最终总结" },
      ],
      {
        messageCreatedAt: Array.from({ length: 5 }, () => at(45_000)),
        toolExecutionCoverage: {
          executionIds: [t3Op1.id, t3Op2.id],
          representation: "raw_transcript",
        },
      },
    );
    writableStore.close();
    writableClosed = true;

    const readOnlyStore = new ThreadStore(dir, { readOnly: true });
    const readOnlyService = new RuntimeService(createFixture(readOnlyStore).engine, readOnlyStore);
    try {
      const parsedThreadId = threadIdSchema.parse(IDS.thread);
      const fullSnapshot = readOnlyService.snapshotThread({
        threadId: parsedThreadId,
        limit: 100,
      });
      // 确认 limit=1 单独读取最后一轮末尾总结时，依然借助页外同轮工具锚点推进到了 +45_001ms
      const lastSummaryOnly = readOnlyService.snapshotThread({
        threadId: parsedThreadId,
        limit: 1,
      });
      assert.equal(lastSummaryOnly.messages.items.length, 1);
      assert.equal(lastSummaryOnly.messages.items[0]?.createdAt, at(45_001));

      // 遍历各种分页大小从尾逐页翻到头，验证合并后的每个 sequence 与全量快照逐毫秒恒等
      for (const pageSize of [1, 2, 3, 4, 5, 6, 7, 13, 20]) {
        const collectedPages: (typeof fullSnapshot.messages.items)[] = [];
        let cursor: number | undefined;
        for (let guard = 0; guard < 50; guard += 1) {
          const page = readOnlyService.snapshotThread({
            threadId: parsedThreadId,
            limit: pageSize,
            ...(cursor !== undefined ? { messageBeforeSequence: cursor } : {}),
          });
          collectedPages.push(page.messages.items);
          if (page.messages.nextBeforeSequence === null) {
            break;
          }
          cursor = page.messages.nextBeforeSequence;
        }
        const mergedItems = collectedPages.reverse().flat();
        assert.deepEqual(
          mergedItems,
          fullSnapshot.messages.items,
          `pageSize=${String(pageSize)} 分页回翻结果必须与全量快照完全一致`,
        );
      }
    } finally {
      await readOnlyService.close();
      readOnlyStore.close();
    }
  } finally {
    if (!writableClosed) {
      writableStore.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
