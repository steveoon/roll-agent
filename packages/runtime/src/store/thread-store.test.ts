import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { ModelMessage } from "ai";
import type { RuntimeEventCursor } from "@roll-agent/protocol";
import {
  RUNTIME_EVENT_RETENTION_POLICY,
  RuntimeEventCursorExpiredError,
  RuntimeEventCursorGapError,
  ThreadStore,
  TOOL_EXECUTION_RETENTION_POLICY,
  type CommitCompactionInput,
  type ReadCheckpointTranscriptOptions,
} from "./thread-store.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";
import {
  UnsupportedCompactionCheckpointVersionError,
  createCompactionSummary,
  createEmptyCompactionToolState,
  type CompactionCheckpointDraftInput,
} from "../engine/compaction-checkpoint.ts";
import {
  createEmptyCompactionSemanticState,
  replaceCompactionSemanticGoal,
} from "../engine/compaction-semantic-state.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-threads-"));
}

type DatabaseLockWorkerMessage =
  | { readonly type: "locked" | "released" }
  | { readonly type: "error"; readonly message: string };

function isDatabaseLockWorkerMessage(value: unknown): value is DatabaseLockWorkerMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  if (value.type === "locked" || value.type === "released") {
    return true;
  }
  return value.type === "error" && "message" in value && typeof value.message === "string";
}

function waitForDatabaseLockWorker(
  worker: Worker,
  expectedType: "locked" | "released",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for database lock worker to report ${expectedType}`));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (!isDatabaseLockWorkerMessage(message)) {
        return;
      }
      if (message.type === "error") {
        cleanup();
        reject(new Error(message.message));
      } else if (message.type === expectedType) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Database lock worker exited with code ${String(code)}`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

test("ThreadStore 在 POSIX 上收紧 raw evidence 目录与数据库权限", () => {
  if (process.platform === "win32") {
    return;
  }
  const parent = tempDir();
  const dir = join(parent, "nested", "threads");
  try {
    chmodSync(parent, 0o755);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const store = new ThreadStore(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "threads.db")).mode & 0o777, 0o600);
    store.close();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function execution(id: string, toolCallId: string, secret: string) {
  return createToolExecutionRecord({
    id,
    toolCallId,
    agentName: "demo-agent",
    toolName: "lookup",
    input: { query: "hello" },
    result: successfulToolResult("visible", {
      raw: {
        content: [{ type: "text", text: "visible" }],
        structuredContent: { answer: 42 },
        _meta: { secret },
      },
    }),
    createdAt: new Date().toISOString(),
  });
}

function checkpointDraft(
  overrides: Partial<CompactionCheckpointDraftInput> = {},
): CompactionCheckpointDraftInput {
  return {
    constraints: [],
    resources: [],
    toolState: createEmptyCompactionToolState(),
    runningWork: [],
    context: {
      cwd: "/workspace",
      stableRuleIds: ["tool-grounding/v1"],
      skills: [],
      explicitSkillNames: [],
    },
    summary: { status: "skipped" },
    ...overrides,
  };
}

function legacyExplicitSkillMessage(skillBody: string): ModelMessage {
  return {
    role: "user",
    content: "/demo continue",
    providerOptions: {
      rollHarness: {
        explicitSkillCheckpoint: {
          version: 1,
          kind: "explicit-skill",
          snapshot: {
            userPrompt: "continue",
            modelUserContent: skillBody,
            skillNames: ["demo"],
          },
        },
      },
    },
  };
}

function currentCompactionGuard(
  store: ThreadStore,
  threadId: string,
): Pick<
  CommitCompactionInput,
  | "evidenceWatermarks"
  | "expectedActiveMessages"
  | "expectedLatestCheckpointId"
  | "semanticEvidenceWatermarks"
  | "semanticState"
> {
  return {
    expectedActiveMessages: store.getMessages(threadId),
    expectedLatestCheckpointId: store.getLatestCheckpoint(threadId)?.id,
    semanticState: createEmptyCompactionSemanticState(),
    semanticEvidenceWatermarks: {
      messagesThroughSequence: -1,
      toolExecutionsThroughSequence: -1,
    },
    evidenceWatermarks: {
      transcriptMessagesThroughSequence:
        store.listTranscriptMessages(threadId, { limit: 500 }).at(-1)?.sequence ?? -1,
      toolExecutionsThroughSequence:
        store.listToolExecutions(threadId, { limit: 500 }).at(-1)?.sequence ?? -1,
    },
  };
}

test("ThreadStore 创建与查询 thread", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread({ title: "t1", model: "m1" });
    assert.ok(store.hasThread(id));
    const record = store.getThread(id);
    assert.equal(record?.title, "t1");
    assert.equal(record?.model, "m1");
    assert.equal(store.hasThread("nope"), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "ThreadStore initialization waits for a cross-thread BEGIN IMMEDIATE lock",
  { timeout: 10_000 },
  async () => {
    const dir = tempDir();
    let worker: Worker | undefined;
    let store: ThreadStore | undefined;
    try {
      const seed = new ThreadStore(dir);
      seed.close();

      worker = new Worker(
        `
          const { parentPort, workerData } = require("node:worker_threads");
          const { DatabaseSync } = require("node:sqlite");
          const database = new DatabaseSync(workerData.databasePath);
          const fail = (error) => {
            try {
              database.close();
            } catch {}
            parentPort.postMessage({
              type: "error",
              message: error instanceof Error ? error.stack ?? error.message : String(error),
            });
            parentPort.close();
          };
          try {
            database.exec("BEGIN IMMEDIATE");
            parentPort.postMessage({ type: "locked" });
            parentPort.once("message", ({ delayMs }) => {
              setTimeout(() => {
                try {
                  database.exec("COMMIT");
                  database.close();
                  parentPort.postMessage({ type: "released" });
                  parentPort.close();
                } catch (error) {
                  fail(error);
                }
              }, delayMs);
            });
          } catch (error) {
            fail(error);
          }
        `,
        {
          eval: true,
          execArgv: ["--experimental-sqlite"],
          workerData: { databasePath: join(dir, "threads.db") },
        },
      );

      await waitForDatabaseLockWorker(worker, "locked");
      const released = waitForDatabaseLockWorker(worker, "released");
      const startedAt = Date.now();
      worker.postMessage({ delayMs: 500 });

      let initializationError: unknown;
      try {
        store = new ThreadStore(dir);
      } catch (error) {
        initializationError = error;
      }
      const elapsedMs = Date.now() - startedAt;
      await released;

      if (initializationError !== undefined) {
        throw initializationError;
      }
      assert.ok(store);
      assert.ok(elapsedMs >= 400, `expected initialization to wait for lock, got ${elapsedMs}ms`);
      const threadId = store.createThread({ title: "after-lock" });
      assert.equal(store.getThread(threadId)?.title, "after-lock");
    } finally {
      store?.close();
      if (worker !== undefined) {
        await worker.terminate();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("ThreadStore append/get messages 保序且可多次追加", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread();
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    store.appendMessages(id, messages);
    store.appendMessages(id, [{ role: "user", content: "again" }]);
    const got = store.getMessages(id);
    assert.equal(got.length, 3);
    assert.equal(got[0]?.role, "user");
    assert.equal(got[1]?.role, "assistant");
    assert.equal(got[2]?.role, "user");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore replaceMessages 重写历史并 reindex,append 衔接", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread();
    store.appendMessages(id, [
      { role: "user", content: "t1-u" },
      { role: "assistant", content: "t1-a" },
      { role: "user", content: "t2-u" },
      { role: "assistant", content: "t2-a" },
    ]);

    store.replaceMessages(id, [
      { role: "user", content: "summary" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "t2-u" },
      { role: "assistant", content: "t2-a" },
    ]);

    let got = store.getMessages(id);
    assert.equal(got.length, 4);
    assert.equal(got[0]?.content, "summary");

    store.appendMessages(id, [{ role: "user", content: "t3-u" }]);
    got = store.getMessages(id);
    assert.equal(got.length, 5);
    assert.equal(got[4]?.content, "t3-u");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore replaceMessages 持久化跨实例可 resume", () => {
  const dir = tempDir();
  try {
    const first = new ThreadStore(dir);
    const id = first.createThread();
    first.appendMessages(id, [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    first.replaceMessages(id, [{ role: "user", content: "compacted" }]);
    first.close();

    const second = new ThreadStore(dir);
    const got = second.getMessages(id);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.content, "compacted");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore resume round-trip 跨实例持久化", () => {
  const dir = tempDir();
  try {
    const first = new ThreadStore(dir);
    const id = first.createThread({ title: "persist" });
    first.appendMessages(id, [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    first.close();

    const second = new ThreadStore(dir);
    assert.ok(second.hasThread(id));
    const got = second.getMessages(id);
    assert.equal(got.length, 2);
    assert.equal(got[0]?.role, "user");
    const threads = second.listThreads();
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.title, "persist");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore countMessages 与 listThreads 按最近优先（rowid tiebreaker）", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const first = store.createThread({ title: "first" });
    store.appendMessages(first, [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    const second = store.createThread({ title: "second" });
    store.appendMessages(second, [{ role: "user", content: "c" }]);

    assert.equal(store.countMessages(first), 2);
    assert.equal(store.countMessages(second), 1);

    const threads = store.listThreads();
    assert.equal(threads[0]?.id, second);
    assert.equal(threads[1]?.id, first);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore updateTitle 更新标题", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread();
    assert.equal(store.getThread(id)?.title, undefined);
    store.updateTitle(id, "新标题");
    assert.equal(store.getThread(id)?.title, "新标题");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore updateModel 更新线程模型", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread({ model: "qwen3.8-max" });
    assert.equal(store.getThread(id)?.model, "qwen3.8-max");
    store.updateModel(id, "gemini-3.8-flash");
    assert.equal(store.getThread(id)?.model, "gemini-3.8-flash");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore deleteThread 删除 thread 并级联消息", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const id = store.createThread({ title: "delete-me" });
    store.appendMessages(id, [{ role: "user", content: "hi" }]);

    store.deleteThread(id);

    assert.equal(store.hasThread(id), false);
    assert.equal(store.countMessages(id), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 不允许向不存在的 thread 追加消息", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    assert.throws(
      () => store.appendMessages("missing", [{ role: "user", content: "hi" }]),
      /不存在/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore tool execution ledger 跨实例保序且不受 replaceMessages 影响", () => {
  const dir = tempDir();
  try {
    const first = new ThreadStore(dir);
    const threadId = first.createThread();
    first.appendMessages(threadId, [{ role: "user", content: "run tools" }]);
    const firstRecord = execution(
      "b4a7fcfa-53fe-4338-b7b9-58c3d28f31e3",
      "shared-call",
      "secret-1",
    );
    const secondRecord = execution(
      "1da8876b-3ead-4998-a878-692e1a33e7bb",
      "shared-call",
      "secret-2",
    );
    assert.equal(first.appendToolExecution(threadId, firstRecord), 0);
    assert.equal(first.appendToolExecution(threadId, secondRecord), 1);
    first.replaceMessages(threadId, [{ role: "user", content: "compacted" }]);
    first.close();

    const second = new ThreadStore(dir);
    const records = second.listToolExecutions(threadId);
    assert.deepEqual(
      records.map(({ sequence, id, toolCallId }) => ({ sequence, id, toolCallId })),
      [
        { sequence: 0, id: firstRecord.id, toolCallId: "shared-call" },
        { sequence: 1, id: secondRecord.id, toolCallId: "shared-call" },
      ],
    );
    const restored = second.getToolExecution(threadId, secondRecord.id);
    assert.equal(restored?.id, secondRecord.id);
    assert.equal(restored?.sequence, 1);
    assert.equal(restored?.persistence?.version, 1);
    assert.doesNotMatch(JSON.stringify(restored), /secret-2/u);
    assert.equal(second.listToolExecutions(threadId, { afterSequence: 0 }).length, 1);
    assert.equal(second.listToolExecutions(threadId, { toolCallId: "missing" }).length, 0);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 按 execution id 原子确认 transcript coverage", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const firstRecord = execution(
      "b91cf465-a1a2-4b82-9cc1-7c8a67705700",
      "reused-call",
      "secret-1",
    );
    const secondRecord = execution(
      "eb556932-26f2-49c1-bc65-2c18019998f1",
      "reused-call",
      "secret-2",
    );
    store.appendToolExecution(threadId, firstRecord);
    store.appendToolExecution(threadId, secondRecord);

    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((record) => record.id),
      [firstRecord.id, secondRecord.id],
    );

    store.appendMessages(
      threadId,
      [{ role: "assistant", content: "first execution is represented" }],
      {
        toolExecutionCoverage: {
          executionIds: [firstRecord.id],
          representation: "raw_transcript",
        },
      },
    );

    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((record) => record.id),
      [secondRecord.id],
    );
    const database = new DatabaseSync(join(dir, "threads.db"));
    const coverage = database
      .prepare(
        `SELECT execution_id, representation, transcript_sequence
           FROM tool_execution_context_coverage
          WHERE thread_id = ?`,
      )
      .get(threadId) as {
      readonly execution_id: string;
      readonly representation: string;
      readonly transcript_sequence: number;
    };
    assert.deepEqual(
      { ...coverage },
      {
        execution_id: firstRecord.id,
        representation: "raw_transcript",
        transcript_sequence: 0,
      },
    );
    database.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore transcript append 失败会连同 exact coverage 一起回滚", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const record = execution("82a36313-95b7-405d-938e-8f31f608fd42", "atomic-coverage", "secret");
    store.appendToolExecution(threadId, record);
    const database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_transcript_coverage_insert
      BEFORE INSERT ON transcript_messages
      BEGIN
        SELECT RAISE(ABORT, 'simulated transcript persistence failure');
      END;
    `);

    assert.throws(
      () =>
        store.appendMessages(threadId, [{ role: "assistant", content: "durable result" }], {
          toolExecutionCoverage: {
            executionIds: [record.id],
            representation: "raw_transcript",
          },
        }),
      /simulated transcript persistence failure/u,
    );
    assert.deepEqual(store.getMessages(threadId), []);
    assert.deepEqual(store.listTranscriptMessages(threadId), []);
    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((entry) => entry.id),
      [record.id],
    );

    database.exec("DROP TRIGGER reject_transcript_coverage_insert;");
    store.appendMessages(threadId, [{ role: "assistant", content: "durable result" }], {
      toolExecutionCoverage: {
        executionIds: [record.id],
        representation: "raw_transcript",
      },
    });
    assert.deepEqual(store.listUncoveredToolExecutions(threadId), []);
    database.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore exact coverage 冲突不会重复追加 transcript marker", () => {
  const dir = tempDir();
  try {
    const first = new ThreadStore(dir);
    const threadId = first.createThread();
    const second = new ThreadStore(dir);
    const record = execution("ae8e028d-bf2e-436f-a28a-aa6ca0850591", "single-coverage", "secret");
    first.appendToolExecution(threadId, record);
    first.appendMessages(threadId, [{ role: "assistant", content: "first recovery marker" }], {
      toolExecutionCoverage: {
        executionIds: [record.id],
        representation: "recovery_evidence",
      },
    });

    assert.throws(
      () =>
        second.appendMessages(
          threadId,
          [{ role: "assistant", content: "duplicate recovery marker" }],
          {
            toolExecutionCoverage: {
              executionIds: [record.id],
              representation: "recovery_evidence",
            },
          },
        ),
      /已被 transcript 覆盖/u,
    );
    assert.deepEqual(second.getMessages(threadId), [
      { role: "assistant", content: "first recovery marker" },
    ]);
    assert.equal(second.countTranscriptMessages(threadId), 1);
    second.close();
    first.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore exact coverage 拒绝跨 thread execution 并回滚消息", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const firstThreadId = store.createThread();
    const secondThreadId = store.createThread();
    const record = execution("34bec2b5-e677-4ca6-9c67-2d4a36fd7e1a", "foreign-coverage", "secret");
    store.appendToolExecution(secondThreadId, record);

    assert.throws(
      () =>
        store.appendMessages(firstThreadId, [{ role: "assistant", content: "must roll back" }], {
          toolExecutionCoverage: {
            executionIds: [record.id],
            representation: "recovery_evidence",
          },
        }),
      /execution/u,
    );
    assert.deepEqual(store.getMessages(firstThreadId), []);
    assert.deepEqual(store.listTranscriptMessages(firstThreadId), []);
    assert.deepEqual(
      store.listUncoveredToolExecutions(secondThreadId).map((entry) => entry.id),
      [record.id],
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore retention 永不删除 uncovered execution", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const expired = {
      ...execution("17dff1ef-a7d8-47bf-85ae-ae9a9e0f03b9", "expired-uncovered", "secret"),
      createdAt: "2000-01-01T00:00:00.000Z",
    };
    store.appendToolExecution(threadId, expired);
    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((entry) => entry.id),
      [expired.id],
    );
    assert.equal(store.getToolExecution(threadId, expired.id)?.id, expired.id);

    store.appendMessages(threadId, [{ role: "assistant", content: "bounded recovery evidence" }], {
      toolExecutionCoverage: {
        executionIds: [expired.id],
        representation: "recovery_evidence",
      },
    });
    assert.equal(store.getToolExecution(threadId, expired.id), undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore schema v5 ledger 迁移为 legacy_assumed coverage", () => {
  const dir = tempDir();
  try {
    const initial = new ThreadStore(dir);
    const threadId = initial.createThread();
    const legacyRecord = execution(
      "c494a969-3ee7-4673-a77d-8399ffea0fba",
      "legacy-covered",
      "secret",
    );
    initial.appendToolExecution(threadId, legacyRecord);
    initial.close();

    const legacy = new DatabaseSync(join(dir, "threads.db"));
    legacy.exec(`
      DROP TABLE tool_execution_context_coverage;
      PRAGMA user_version = 5;
    `);
    legacy.close();

    const migrated = new ThreadStore(dir);
    assert.deepEqual(migrated.listUncoveredToolExecutions(threadId), []);
    migrated.close();

    const inspected = new DatabaseSync(join(dir, "threads.db"));
    const row = inspected
      .prepare(
        `SELECT representation, transcript_sequence
           FROM tool_execution_context_coverage
          WHERE thread_id = ? AND execution_id = ?`,
      )
      .get(threadId, legacyRecord.id) as {
      readonly representation: string;
      readonly transcript_sequence: number | null;
    };
    const version = inspected.prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    assert.deepEqual({ ...row }, { representation: "legacy_assumed", transcript_sequence: null });
    assert.equal(version.user_version, 7);
    inspected.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 原子恢复全部 uncovered execution 且跨重启幂等", () => {
  const dir = tempDir();
  try {
    const initial = new ThreadStore(dir);
    const threadId = initial.createThread();
    for (let index = 0; index < 101; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      initial.appendToolExecution(
        threadId,
        execution(`00000000-0000-4000-8001-${suffix}`, "reused-recovery-call", "secret"),
      );
    }
    initial.close();

    const resumed = new ThreadStore(dir);
    let observedRecords = 0;
    const recovered = resumed.recoverUncoveredToolExecutions(threadId, (records) => {
      observedRecords = records.length;
      assert.equal(new Set(records.map((record) => record.id)).size, 101);
      assert.ok(records.every((record) => record.toolCallId === "reused-recovery-call"));
      return { role: "assistant", content: `recovered ${String(records.length)} executions` };
    });
    assert.equal(observedRecords, 101);
    assert.deepEqual(recovered, {
      role: "assistant",
      content: "recovered 101 executions",
    });
    assert.deepEqual(resumed.listUncoveredToolExecutions(threadId, { limit: 500 }), []);
    resumed.close();

    const inspected = new DatabaseSync(join(dir, "threads.db"));
    const coverage = inspected
      .prepare(
        `SELECT COUNT(*) AS covered_count,
                COUNT(DISTINCT execution_id) AS distinct_count,
                COUNT(DISTINCT transcript_sequence) AS transcript_count,
                MIN(representation) AS representation
           FROM tool_execution_context_coverage
          WHERE thread_id = ?`,
      )
      .get(threadId) as {
      readonly covered_count: number;
      readonly distinct_count: number;
      readonly transcript_count: number;
      readonly representation: string;
    };
    assert.equal(coverage.covered_count, 101);
    assert.equal(coverage.distinct_count, 101);
    assert.equal(coverage.transcript_count, 1);
    assert.equal(coverage.representation, "recovery_evidence");
    inspected.close();

    const idempotent = new ThreadStore(dir);
    const secondRecovery = idempotent.recoverUncoveredToolExecutions(threadId, () => {
      throw new Error("factory must not run when every execution is covered");
    });
    assert.equal(secondRecovery, undefined);
    assert.deepEqual(idempotent.getMessages(threadId), [recovered]);
    assert.equal(idempotent.countTranscriptMessages(threadId), 1);
    idempotent.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore uncovered recovery transcript 失败会回滚 message 与 coverage", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const record = execution("f4ac47af-ed48-45a3-be7c-a6a715fef0b1", "failed-recovery", "secret");
    store.appendToolExecution(threadId, record);
    const database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_uncovered_recovery_insert
      BEFORE INSERT ON transcript_messages
      BEGIN
        SELECT RAISE(ABORT, 'simulated uncovered recovery failure');
      END;
    `);

    assert.throws(
      () =>
        store.recoverUncoveredToolExecutions(threadId, (records) => ({
          role: "assistant",
          content: `recover ${String(records.length)}`,
        })),
      /simulated uncovered recovery failure/u,
    );
    assert.deepEqual(store.getMessages(threadId), []);
    assert.deepEqual(store.listTranscriptMessages(threadId), []);
    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((entry) => entry.id),
      [record.id],
    );

    database.exec("DROP TRIGGER reject_uncovered_recovery_insert;");
    const recovered = store.recoverUncoveredToolExecutions(threadId, (records) => ({
      role: "assistant",
      content: `recover ${String(records.length)}`,
    }));
    assert.deepEqual(recovered, { role: "assistant", content: "recover 1" });
    assert.deepEqual(store.listUncoveredToolExecutions(threadId), []);
    database.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 从 schema v1 迁移后可持久化 ToolExecutionRecord", () => {
  const dir = tempDir();
  try {
    const database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        thread_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, idx),
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      INSERT INTO threads VALUES ('legacy', NULL, NULL, 'now', 'now');
      PRAGMA user_version = 1;
    `);
    database.close();

    const store = new ThreadStore(dir);
    const record = execution(
      "f69f70b2-777b-41ad-bdb9-1d3f75bb65ab",
      "legacy-call",
      "legacy-secret",
    );
    assert.equal(store.appendToolExecution("legacy", record), 0);
    assert.equal(store.listToolExecutions("legacy")[0]?.id, record.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore schema v4 迁移会重写旧 ledger 为有界脱敏投影", () => {
  const dir = tempDir();
  try {
    const initial = new ThreadStore(dir);
    const threadId = initial.createThread();
    const legacy = execution(
      "2816151e-f934-479f-ac78-bd3206b15e62",
      "legacy-raw-call",
      "legacy-ledger-secret",
    );
    const legacySkillBody = "LEGACY_SKILL_BODY_MUST_BE_REMOVED";
    const legacySkillMessage = legacyExplicitSkillMessage(legacySkillBody);
    initial.appendMessages(threadId, [legacySkillMessage]);
    initial.appendToolExecution(threadId, legacy);
    initial.close();

    const database = new DatabaseSync(join(dir, "threads.db"));
    const serializedLegacySkillMessage = JSON.stringify(legacySkillMessage);
    database
      .prepare("UPDATE messages SET content_json = ? WHERE thread_id = ?")
      .run(serializedLegacySkillMessage, threadId);
    database
      .prepare("UPDATE transcript_messages SET message_json = ? WHERE thread_id = ?")
      .run(serializedLegacySkillMessage, threadId);
    database
      .prepare("UPDATE tool_executions SET record_json = ? WHERE thread_id = ?")
      .run(JSON.stringify(legacy), threadId);
    database.exec("PRAGMA user_version = 3;");
    database.close();

    const migrated = new ThreadStore(dir);
    const restored = migrated.getToolExecution(threadId, legacy.id);
    assert.equal(restored?.persistence?.version, 1);
    assert.doesNotMatch(JSON.stringify(restored), /legacy-ledger-secret/u);
    assert.doesNotMatch(
      JSON.stringify(migrated.getMessages(threadId)),
      new RegExp(legacySkillBody),
    );
    assert.doesNotMatch(
      JSON.stringify(migrated.listTranscriptMessages(threadId)),
      new RegExp(legacySkillBody),
    );
    migrated.close();

    const inspected = new DatabaseSync(join(dir, "threads.db"));
    const row = inspected
      .prepare("SELECT record_json FROM tool_executions WHERE thread_id = ?")
      .get(threadId) as { readonly record_json: string };
    assert.doesNotMatch(row.record_json, /legacy-ledger-secret/u);
    assert.equal(
      (inspected.prepare("PRAGMA user_version").get() as { readonly user_version: number })
        .user_version,
      7,
    );
    inspected.close();
    assert.equal(readFileSync(join(dir, "threads.db")).includes("legacy-ledger-secret"), false);
    assert.equal(readFileSync(join(dir, "threads.db")).includes(legacySkillBody), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 所有 message 写入边界都清除 legacy Skill 正文", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const legacySkillBody = "LEGACY_SKILL_BODY_MUST_NEVER_REACH_DISK";
    const legacySkillMessage = legacyExplicitSkillMessage(legacySkillBody);

    store.appendMessages(threadId, [legacySkillMessage]);
    assert.doesNotMatch(JSON.stringify(store.getMessages(threadId)), new RegExp(legacySkillBody));
    assert.doesNotMatch(
      JSON.stringify(store.listTranscriptMessages(threadId)),
      new RegExp(legacySkillBody),
    );

    store.replaceMessages(threadId, [legacySkillMessage]);
    assert.doesNotMatch(JSON.stringify(store.getMessages(threadId)), new RegExp(legacySkillBody));

    store.commitCompaction(threadId, {
      messages: [legacySkillMessage],
      ...currentCompactionGuard(store, threadId),
      draft: checkpointDraft(),
    });
    assert.doesNotMatch(JSON.stringify(store.getMessages(threadId)), new RegExp(legacySkillBody));
    store.close();

    assert.doesNotMatch(readFileSync(join(dir, "threads.db"), "utf8"), new RegExp(legacySkillBody));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore ledger 按 TTL prune 且 sequence 不复用", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const expired = {
      ...execution("41b2045a-14d4-4476-ab54-f4d467d6e135", "expired-call", "secret"),
      createdAt: "2000-01-01T00:00:00.000Z",
    };
    assert.equal(store.appendToolExecution(threadId, expired), 0);
    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((record) => record.sequence),
      [0],
    );
    store.appendMessages(threadId, [{ role: "assistant", content: "covered expired result" }], {
      toolExecutionCoverage: {
        executionIds: [expired.id],
        representation: "recovery_evidence",
      },
    });
    assert.equal(
      store.appendToolExecution(
        threadId,
        execution("9c89c9bd-44ca-4550-8622-c55b7a339d4e", "current-call", "secret"),
      ),
      1,
    );
    assert.deepEqual(
      store.listToolExecutions(threadId).map((record) => record.sequence),
      [1],
    );
    assert.equal(store.getTranscriptCompleteness(threadId), "legacy_snapshot");
    assert.equal(
      store.appendToolExecution(
        threadId,
        execution("47c46fee-e878-4dd1-8776-929982102f7d", "next-call", "secret"),
      ),
      2,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore v4 reopen 也会清理已过期的 inactive ledger", () => {
  const dir = tempDir();
  try {
    const initial = new ThreadStore(dir);
    const threadId = initial.createThread();
    const firstRecord = execution("2b767742-b71a-42bd-ac92-f56af70b9f6f", "inactive-0", "secret");
    const secondRecord = execution("c6fdc054-201f-490d-8956-a1a76fd89ba8", "inactive-1", "secret");
    initial.appendToolExecution(threadId, firstRecord);
    initial.appendToolExecution(threadId, secondRecord);
    initial.appendMessages(threadId, [{ role: "assistant", content: "covered old records" }], {
      toolExecutionCoverage: {
        executionIds: [firstRecord.id, secondRecord.id],
        representation: "recovery_evidence",
      },
    });
    initial.close();

    const database = new DatabaseSync(join(dir, "threads.db"));
    database.prepare("UPDATE tool_executions SET created_at = '2000-01-01T00:00:00.000Z'").run();
    database.close();

    const reopened = new ThreadStore(dir);
    assert.deepEqual(
      reopened.listToolExecutions(threadId).map((record) => record.sequence),
      [],
    );
    assert.equal(reopened.getTranscriptCompleteness(threadId), "legacy_snapshot");
    assert.equal(
      reopened.appendToolExecution(
        threadId,
        execution("a2831468-48e3-443f-bfb8-f2c3bc2e675d", "inactive-next", "secret"),
      ),
      2,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore retention 后 checkpoint/read/resume 都保守降级并由后续 compaction 继承", () => {
  const dir = tempDir();
  try {
    const initial = new ThreadStore(dir);
    const threadId = initial.createThread();
    const oldRecord = execution("ffb38c00-8351-4cc0-803a-fae7ef578f55", "checkpoint-old", "secret");
    const liveRecord = execution(
      "22de59cf-b2db-4ce7-af9d-60f942141794",
      "checkpoint-live",
      "secret",
    );
    initial.appendToolExecution(threadId, oldRecord);
    initial.appendToolExecution(threadId, liveRecord);
    initial.appendMessages(threadId, [{ role: "assistant", content: "covered checkpoint tools" }], {
      toolExecutionCoverage: {
        executionIds: [oldRecord.id, liveRecord.id],
        representation: "recovery_evidence",
      },
    });
    const checkpoint = initial.commitCompaction(threadId, {
      messages: [{ role: "user", content: "summary-before-retention" }],
      ...currentCompactionGuard(initial, threadId),
      draft: checkpointDraft(),
    });
    assert.equal(checkpoint.transcript.completeness, "complete");
    initial.close();

    const database = new DatabaseSync(join(dir, "threads.db"));
    database
      .prepare(
        "UPDATE tool_executions SET created_at = '2000-01-01T00:00:00.000Z' WHERE thread_id = ? AND sequence = 0",
      )
      .run(threadId);
    database.close();

    const reopened = new ThreadStore(dir);
    assert.deepEqual(
      reopened.listToolExecutions(threadId).map((record) => record.sequence),
      [1],
    );
    assert.equal(reopened.getTranscriptCompleteness(threadId), "legacy_snapshot");
    assert.equal(
      reopened.getLatestCheckpoint(threadId)?.transcript.completeness,
      "legacy_snapshot",
    );
    assert.equal(reopened.getLatestCheckpoint(threadId)?.toolState.integrityStatus, "sanitized");
    assert.equal(
      reopened.getCheckpoint(threadId, checkpoint.id)?.transcript.completeness,
      "legacy_snapshot",
    );
    assert.equal(
      reopened.loadSessionState(threadId).checkpoint?.transcript.completeness,
      "legacy_snapshot",
    );
    const page = reopened.readCheckpointTranscript(threadId, {
      checkpointId: checkpoint.id,
      kind: "tool_execution",
    });
    assert.equal(page.completeness, "legacy_snapshot");
    assert.deepEqual(
      page.entries.map((entry) => entry.sequence),
      [1],
    );

    const inherited = reopened.commitCompaction(threadId, {
      messages: [{ role: "user", content: "summary-after-retention" }],
      ...currentCompactionGuard(reopened, threadId),
      draft: checkpointDraft(),
    });
    assert.equal(inherited.transcript.completeness, "legacy_snapshot");
    assert.equal(inherited.toolState.integrityStatus, "sanitized");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore ledger aggregate bytes 超限时保留有界新后缀", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const large = createToolExecutionRecord({
      id: "00000000-0000-4000-8000-000000000000",
      toolCallId: "large-0",
      agentName: "demo-agent",
      toolName: "read",
      input: {},
      result: successfulToolResult("ok", { raw: { text: "x".repeat(60 * 1_024) } }),
    });
    store.appendToolExecution(threadId, large);
    store.appendMessages(threadId, [{ role: "assistant", content: "covered large records" }], {
      toolExecutionCoverage: {
        executionIds: [large.id],
        representation: "recovery_evidence",
      },
    });
    const persisted = store.getToolExecution(threadId, large.id);
    assert.ok(persisted);
    store.close();

    const database = new DatabaseSync(join(dir, "threads.db"));
    const insert = database.prepare(
      `INSERT INTO tool_executions
         (thread_id, sequence, id, tool_call_id, agent_name, tool_name, record_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCoverage = database.prepare(
      `INSERT INTO tool_execution_context_coverage
         (thread_id, execution_id, representation, transcript_sequence, created_at)
       VALUES (?, ?, 'recovery_evidence', 0, ?)`,
    );
    database.exec("BEGIN IMMEDIATE");
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      const suffix = sequence.toString(16).padStart(12, "0");
      const id = `00000000-0000-4000-8000-${suffix}`;
      const record = { ...persisted, id, toolCallId: `large-${String(sequence)}` };
      insert.run(
        threadId,
        sequence,
        id,
        record.toolCallId,
        record.agentName,
        record.toolName,
        JSON.stringify(record),
        record.createdAt,
      );
      insertCoverage.run(threadId, id, record.createdAt);
    }
    database.exec("COMMIT");
    database.close();

    const bounded = new ThreadStore(dir);
    const nextSequence = bounded.appendToolExecution(
      threadId,
      execution("efc13f2c-3819-4eaf-831d-51eaa6ec777c", "after-quota", "secret"),
    );
    assert.equal(nextSequence, 301);
    assert.equal(bounded.getTranscriptCompleteness(threadId), "legacy_snapshot");
    bounded.close();

    const inspected = new DatabaseSync(join(dir, "threads.db"));
    const totals = inspected
      .prepare(
        `SELECT COUNT(*) AS record_count,
                COALESCE(SUM(length(CAST(record_json AS BLOB))), 0) AS byte_count,
                MIN(sequence) AS min_sequence,
                MAX(sequence) AS max_sequence
           FROM tool_executions
          WHERE thread_id = ?`,
      )
      .get(threadId) as {
      readonly record_count: number;
      readonly byte_count: number;
      readonly min_sequence: number;
      readonly max_sequence: number;
    };
    assert.ok(totals.byte_count <= TOOL_EXECUTION_RETENTION_POLICY.maxBytesPerThread);
    assert.ok(totals.record_count < 302);
    assert.ok(totals.min_sequence > 0);
    assert.equal(totals.max_sequence, 301);
    inspected.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore deleteThread 级联删除 Tool execution ledger", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const record = execution("079f687b-2ec1-4dc8-852f-221d9c59b8d5", "call-delete", "secret");
    store.appendToolExecution(threadId, record);
    store.appendMessages(threadId, [{ role: "assistant", content: "covered before delete" }], {
      toolExecutionCoverage: {
        executionIds: [record.id],
        representation: "raw_transcript",
      },
    });
    store.deleteThread(threadId);
    assert.deepEqual(store.listToolExecutions(threadId), []);
    const database = new DatabaseSync(join(dir, "threads.db"));
    const remainingCoverage = database
      .prepare("SELECT COUNT(*) AS count FROM tool_execution_context_coverage WHERE thread_id = ?")
      .get(threadId) as { readonly count: number };
    assert.equal(remainingCoverage.count, 0);
    database.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore appendMessages 原子归档 transcript，replaceMessages 不销毁原文", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [
      { role: "user", content: "原始目标" },
      { role: "assistant", content: "原始回复" },
    ]);
    store.replaceMessages(threadId, [
      { role: "user", content: "压缩摘要" },
      { role: "assistant", content: "已读取" },
    ]);

    assert.deepEqual(
      store.listTranscriptMessages(threadId).map((entry) => ({
        sequence: entry.sequence,
        provenance: entry.provenance,
        content: entry.message.content,
      })),
      [
        { sequence: 0, provenance: "native", content: "原始目标" },
        { sequence: 1, provenance: "native", content: "原始回复" },
      ],
    );
    assert.equal(store.getTranscriptCompleteness(threadId), "complete");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 按独立游标返回最近 transcript 与 Tool execution 页面", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(
      threadId,
      ["message-0", "message-1", "message-2", "message-3"].map((content) => ({
        role: "user" as const,
        content,
      })),
    );
    (
      [
        ["177ece3b-4f12-4850-9255-39f7652a331a", "call-0"],
        ["277ece3b-4f12-4850-9255-39f7652a331b", "call-1"],
        ["377ece3b-4f12-4850-9255-39f7652a331c", "call-2"],
        ["477ece3b-4f12-4850-9255-39f7652a331d", "call-3"],
      ] as const
    ).forEach(([id, toolCallId]) => {
      store.appendToolExecution(threadId, execution(id, toolCallId, `secret-${toolCallId}`));
    });

    const recentMessages = store.listRecentTranscriptMessages(threadId, { limit: 2 });
    assert.deepEqual(
      recentMessages.entries.map((entry) => [entry.sequence, entry.message.content]),
      [
        [2, "message-2"],
        [3, "message-3"],
      ],
    );
    assert.equal(recentMessages.nextBeforeSequence, 2);
    assert.deepEqual(
      store
        .listRecentTranscriptMessages(threadId, {
          beforeSequence: recentMessages.nextBeforeSequence,
          limit: 2,
        })
        .entries.map((entry) => entry.sequence),
      [0, 1],
    );

    const recentOperations = store.listRecentToolExecutions(threadId, { limit: 2 });
    assert.deepEqual(
      recentOperations.entries.map((entry) => entry.sequence),
      [2, 3],
    );
    assert.equal(recentOperations.nextBeforeSequence, 2);
    const earlierOperations = store.listRecentToolExecutions(threadId, {
      beforeSequence: recentOperations.nextBeforeSequence,
      limit: 2,
    });
    assert.deepEqual(
      earlierOperations.entries.map((entry) => entry.sequence),
      [0, 1],
    );
    assert.equal(earlierOperations.nextBeforeSequence, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore commitCompaction 原子写 active projection、versioned checkpoint 与增量 ranges", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [
      { role: "user", content: "turn-1" },
      { role: "assistant", content: "answer-1" },
    ]);
    const firstExecution = execution("177ece3b-4f12-4850-9255-39f7652a331a", "call-1", "secret-1");
    store.appendToolExecution(threadId, firstExecution);

    const first = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "summary-1" }],
      ...currentCompactionGuard(store, threadId),
      semanticState: replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
        verbatimRequest: "turn-1",
        sourceSequence: 0,
      }),
      draft: checkpointDraft({
        goal: { verbatimRequest: "turn-1", sourceSequence: 0, status: "active" },
      }),
    });
    assert.equal(first.version, 2);
    assert.equal(first.generation, 1);
    assert.deepEqual(first.transcript.messages, {
      fromSequenceExclusive: -1,
      throughSequence: 1,
    });
    assert.deepEqual(first.transcript.toolExecutions, {
      fromSequenceExclusive: -1,
      throughSequence: 0,
    });
    assert.equal(store.getMessages(threadId)[0]?.content, "summary-1");

    store.appendMessages(threadId, [
      { role: "user", content: "turn-2" },
      { role: "assistant", content: "answer-2" },
    ]);
    store.appendToolExecution(
      threadId,
      execution("ad32969c-5f5c-426f-bbc7-d233d2512d39", "call-2", "secret-2"),
    );
    const second = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "summary-2" }],
      ...currentCompactionGuard(store, threadId),
      semanticState: replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
        verbatimRequest: "turn-2",
        sourceSequence: 2,
      }),
      draft: checkpointDraft({
        goal: { verbatimRequest: "turn-2", sourceSequence: 2, status: "active" },
      }),
    });

    assert.equal(second.generation, 2);
    assert.equal(second.previousCheckpointId, first.id);
    assert.deepEqual(second.transcript.messages, {
      fromSequenceExclusive: 1,
      throughSequence: 3,
    });
    assert.deepEqual(second.transcript.toolExecutions, {
      fromSequenceExclusive: 0,
      throughSequence: 1,
    });
    assert.deepEqual(store.loadSessionState(threadId), {
      messages: [{ role: "user", content: "summary-2" }],
      checkpoint: second,
      transcriptCompleteness: "complete",
    });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore commitCompaction 保持 draft 快照，并拒绝覆盖晚到 active projection", () => {
  const dir = tempDir();
  try {
    const compactionStore = new ThreadStore(dir);
    const concurrentWriter = new ThreadStore(dir);
    const threadId = compactionStore.createThread();
    compactionStore.appendMessages(threadId, [
      { role: "user", content: "captured goal" },
      { role: "assistant", content: "captured answer" },
    ]);
    compactionStore.appendToolExecution(
      threadId,
      execution("23237819-c8bb-41a6-b40a-8680647a613c", "captured-call", "captured-secret"),
    );

    const capturedGuard = currentCompactionGuard(compactionStore, threadId);
    concurrentWriter.appendToolExecution(
      threadId,
      execution("4274128c-52a1-4330-a12e-57900d9b096b", "late-call", "late-secret"),
    );

    const first = compactionStore.commitCompaction(threadId, {
      messages: [{ role: "user", content: "captured summary" }],
      ...capturedGuard,
      draft: checkpointDraft(),
    });
    assert.deepEqual(first.transcript.messages, {
      fromSequenceExclusive: -1,
      throughSequence: 1,
    });
    assert.deepEqual(first.transcript.toolExecutions, {
      fromSequenceExclusive: -1,
      throughSequence: 0,
    });
    assert.deepEqual(
      compactionStore
        .readCheckpointTranscript(threadId, {
          checkpointId: first.id,
          kind: "message",
        })
        .entries.map((entry) => entry.sequence),
      [0, 1],
    );
    assert.deepEqual(
      compactionStore
        .readCheckpointTranscript(threadId, {
          checkpointId: first.id,
          kind: "tool_execution",
        })
        .entries.map((entry) => entry.sequence),
      [0],
    );

    const staleAncestryGuard = currentCompactionGuard(compactionStore, threadId);
    const concurrentCheckpoint = concurrentWriter.commitCompaction(threadId, {
      messages: compactionStore.getMessages(threadId),
      ...currentCompactionGuard(concurrentWriter, threadId),
      draft: checkpointDraft(),
    });
    assert.throws(
      () =>
        compactionStore.commitCompaction(threadId, {
          messages: [{ role: "user", content: "stale ancestry summary" }],
          ...staleAncestryGuard,
          draft: checkpointDraft(),
        }),
      /checkpoint ancestry changed/u,
    );

    const staleProjectionGuard = currentCompactionGuard(compactionStore, threadId);
    concurrentWriter.appendMessages(threadId, [{ role: "user", content: "late goal" }]);
    assert.throws(
      () =>
        compactionStore.commitCompaction(threadId, {
          messages: [{ role: "user", content: "stale projection summary" }],
          ...staleProjectionGuard,
          draft: checkpointDraft(),
        }),
      /active projection changed/u,
    );
    assert.equal(compactionStore.getLatestCheckpoint(threadId)?.id, concurrentCheckpoint.id);
    assert.deepEqual(compactionStore.getMessages(threadId), [
      { role: "user", content: "captured summary" },
      { role: "user", content: "late goal" },
    ]);

    const fresh = compactionStore.commitCompaction(threadId, {
      messages: [{ role: "user", content: "fresh summary" }],
      ...currentCompactionGuard(compactionStore, threadId),
      draft: checkpointDraft(),
    });
    assert.deepEqual(fresh.transcript.messages, {
      fromSequenceExclusive: 1,
      throughSequence: 2,
    });
    assert.deepEqual(fresh.transcript.toolExecutions, {
      fromSequenceExclusive: 1,
      throughSequence: 1,
    });

    assert.throws(
      () =>
        compactionStore.commitCompaction(threadId, {
          messages: [{ role: "user", content: "impossible summary" }],
          expectedActiveMessages: compactionStore.getMessages(threadId),
          expectedLatestCheckpointId: fresh.id,
          draft: checkpointDraft(),
          semanticState: createEmptyCompactionSemanticState(),
          semanticEvidenceWatermarks: {
            messagesThroughSequence: 2,
            toolExecutionsThroughSequence: 1,
          },
          evidenceWatermarks: {
            transcriptMessagesThroughSequence: 3,
            toolExecutionsThroughSequence: 2,
          },
        }),
      /watermark .* outside the available range/u,
    );
    assert.equal(compactionStore.getLatestCheckpoint(threadId)?.id, fresh.id);

    concurrentWriter.close();
    compactionStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore compaction 拒绝 malformed Tool protocol，resume 则确定性修复旧 active projection", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const dangling: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "保留说明" },
        { type: "tool-call", toolCallId: "dangling", toolName: "lookup", input: {} },
      ],
    };
    store.appendMessages(threadId, [{ role: "user", content: "goal" }]);

    assert.throws(
      () =>
        store.commitCompaction(threadId, {
          messages: [dangling],
          ...currentCompactionGuard(store, threadId),
          draft: checkpointDraft(),
        }),
      /malformed Tool protocol: dangling/u,
    );
    assert.deepEqual(store.getMessages(threadId), [{ role: "user", content: "goal" }]);
    assert.equal(store.getLatestCheckpoint(threadId), undefined);

    store.replaceMessages(threadId, [
      dangling,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "orphan",
            toolName: "lookup",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ]);
    assert.deepEqual(store.loadSessionState(threadId).messages, [
      { role: "assistant", content: [{ type: "text", text: "保留说明" }] },
    ]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore fallback checkpoint 不覆盖最后有效语义摘要选择点", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [{ role: "user", content: "goal" }]);
    const validSummary = createCompactionSummary(
      "当前目标：修复 checkpoint 恢复。关键约束：保留旧 thread。下一步：运行 store 测试并核对 transcript 证据。",
    );
    assert.equal(validSummary.status, "valid");
    const valid = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "valid projection" }],
      ...currentCompactionGuard(store, threadId),
      draft: checkpointDraft({ summary: validSummary }),
    });
    const fallback = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "fallback projection" }],
      ...currentCompactionGuard(store, threadId),
      draft: checkpointDraft({
        summary: { status: "fallback", reason: "summary lacks concrete task evidence" },
      }),
    });

    assert.equal(store.getLatestCheckpoint(threadId)?.id, fallback.id);
    assert.equal(fallback.summary.status, "fallback");
    assert.equal(fallback.summary.lastValidCheckpointId, valid.id);
    assert.equal(store.getLatestSummaryCheckpoint(threadId)?.id, valid.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore checkpoint transcript 受 checkpoint/thread/range 约束并可分页", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const otherThreadId = store.createThread();
    store.appendMessages(threadId, [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
    store.appendToolExecution(
      threadId,
      execution("06586b20-34a8-4f93-91ff-70ae05068d8e", "call-page", "secret"),
    );
    const checkpoint = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "summary" }],
      ...currentCompactionGuard(store, threadId),
      draft: checkpointDraft(),
    });

    const firstPage = store.readCheckpointTranscript(threadId, {
      checkpointId: checkpoint.id,
      kind: "message",
      limit: 1,
    });
    assert.equal(firstPage.entries.length, 1);
    assert.equal(firstPage.entries[0]?.sequence, 0);
    assert.equal(firstPage.nextAfterSequence, 0);
    const secondPage = store.readCheckpointTranscript(threadId, {
      checkpointId: checkpoint.id,
      kind: "message",
      afterSequence: firstPage.nextAfterSequence,
      limit: 2,
    });
    assert.deepEqual(
      secondPage.entries.map((entry) => entry.sequence),
      [1, 2],
    );

    const toolPage = store.readCheckpointTranscript(threadId, {
      checkpointId: checkpoint.id,
      kind: "tool_execution",
    });
    assert.equal(toolPage.entries[0]?.kind, "tool_execution");
    assert.equal(toolPage.entries[0]?.sequence, 0);
    assert.throws(
      () =>
        store.readCheckpointTranscript(otherThreadId, {
          checkpointId: checkpoint.id,
          kind: "message",
        }),
      /不属于当前 thread/u,
    );
    assert.throws(
      () =>
        store.readCheckpointTranscript(threadId, {
          checkpointId: checkpoint.id,
          kind: "invalid",
        } as unknown as ReadCheckpointTranscriptOptions),
      /kind 必须/u,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore V1 transcript archive 与 checkpoint 同事务回滚", () => {
  const dir = tempDir();
  try {
    const initialStore = new ThreadStore(dir);
    const threadId = initialStore.createThread();
    const activeMessages = [{ role: "user", content: "legacy goal" }] as const;
    initialStore.appendMessages(threadId, activeMessages);
    const seeded = initialStore.commitCompaction(threadId, {
      messages: activeMessages,
      ...currentCompactionGuard(initialStore, threadId),
      draft: checkpointDraft(),
    });
    initialStore.close();

    const legacyCheckpoint = {
      version: 1,
      id: seeded.id,
      generation: seeded.generation,
      createdAt: seeded.createdAt,
      transcript: seeded.transcript,
      goal: seeded.goal,
      constraints: seeded.constraints,
      resources: seeded.resources,
      toolState: seeded.toolState,
      runningWork: seeded.runningWork,
      context: seeded.context,
      summary: seeded.summary,
    };
    const database = new DatabaseSync(join(dir, "threads.db"));
    database
      .prepare(
        `UPDATE compaction_checkpoints
            SET schema_version = 1, checkpoint_json = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(legacyCheckpoint), seeded.id);
    database.close();

    const store = new ThreadStore(dir);
    const transcriptBefore = store.listTranscriptMessages(threadId, { limit: 500 });
    assert.throws(
      () =>
        store.commitCompaction(threadId, {
          messages: activeMessages,
          ...currentCompactionGuard(store, threadId),
          draft: checkpointDraft({
            goal: { verbatimRequest: "legacy goal", sourceSequence: 0, status: "active" },
          }),
          legacySnapshotTranscriptFragments: ["ROLLBACK_LEGACY_MARKER"],
        }),
      /V2 goal compatibility projection requires semanticState.goal/u,
    );
    assert.deepEqual(store.listTranscriptMessages(threadId, { limit: 500 }), transcriptBefore);
    assert.deepEqual(store.getMessages(threadId), activeMessages);
    assert.equal(store.getLatestCheckpoint(threadId)?.id, seeded.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore schema v2 迁移保守标记 legacy_snapshot，并在缺 tool 表时自愈", () => {
  const dir = tempDir();
  try {
    const database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        thread_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, idx),
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      INSERT INTO threads VALUES ('legacy-v2', NULL, NULL, 'legacy-time', 'legacy-time');
      INSERT INTO messages VALUES (
        'legacy-v2', 0, 'user', '{"role":"user","content":"legacy goal"}', 'legacy-time'
      );
      PRAGMA user_version = 2;
    `);
    database.close();

    const store = new ThreadStore(dir);
    assert.equal(store.getTranscriptCompleteness("legacy-v2"), "legacy_snapshot");
    assert.deepEqual(store.listTranscriptMessages("legacy-v2"), [
      {
        sequence: 0,
        provenance: "legacy_snapshot",
        createdAt: "legacy-time",
        message: { role: "user", content: "legacy goal" },
      },
    ]);
    const record = execution("af79e95e-e24b-4863-a8a7-6729e909ea78", "self-healed-table", "secret");
    assert.equal(store.appendToolExecution("legacy-v2", record), 0);
    assert.equal(store.listToolExecutions("legacy-v2")[0]?.id, record.id);
    assert.equal(store.loadSessionState("legacy-v2").checkpoint, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore schema v2 迁移跳过无父 thread 的 legacy message", () => {
  const dir = tempDir();
  try {
    const database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        thread_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, idx)
      );
      INSERT INTO threads VALUES ('legacy-live', NULL, NULL, 'legacy-time', 'legacy-time');
      INSERT INTO messages VALUES (
        'legacy-live', 0, 'user', '{"role":"user","content":"live goal"}', 'legacy-time'
      );
      INSERT INTO messages VALUES (
        'legacy-deleted', 0, 'user', '{"role":"user","content":"orphan goal"}', 'legacy-time'
      );
      PRAGMA user_version = 2;
    `);
    database.close();

    const store = new ThreadStore(dir);
    assert.deepEqual(store.listTranscriptMessages("legacy-live"), [
      {
        sequence: 0,
        provenance: "legacy_snapshot",
        createdAt: "legacy-time",
        message: { role: "user", content: "live goal" },
      },
    ]);
    assert.deepEqual(store.listTranscriptMessages("legacy-deleted"), []);
    assert.equal(store.countMessages("legacy-deleted"), 0);
    store.close();

    const migrated = new DatabaseSync(join(dir, "threads.db"));
    const foreignKeys = migrated
      .prepare("PRAGMA foreign_key_list(messages)")
      .all() as unknown as ReadonlyArray<{
      readonly table: string;
      readonly from: string;
      readonly to: string;
      readonly on_delete: string;
    }>;
    assert.ok(
      foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === "threads" &&
          foreignKey.from === "thread_id" &&
          foreignKey.to === "id" &&
          foreignKey.on_delete === "CASCADE",
      ),
    );
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    const version = migrated.prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    assert.equal(version.user_version, 7);
    migrated.close();

    const reopened = new ThreadStore(dir);
    reopened.deleteThread("legacy-live");
    assert.equal(reopened.countMessages("legacy-live"), 0);
    assert.deepEqual(reopened.listTranscriptMessages("legacy-live"), []);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 跳过损坏的最新 checkpoint，继续返回上一条有效记录", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [{ role: "user", content: "goal" }]);
    const valid = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "summary" }],
      ...currentCompactionGuard(store, threadId),
      draft: checkpointDraft(),
    });
    store.close();

    const database = new DatabaseSync(join(dir, "threads.db"));
    database
      .prepare(
        `INSERT INTO compaction_checkpoints
           (id, thread_id, generation, schema_version,
            message_from_sequence, message_through_sequence,
            tool_from_sequence, tool_through_sequence,
            checkpoint_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "51aabf47-369d-40cd-b409-ae4c3f3e07bb",
        threadId,
        2,
        2,
        0,
        0,
        -1,
        -1,
        JSON.stringify({ version: 2 }),
        "2026-07-17T10:00:00.000Z",
      );
    database.close();

    const reopened = new ThreadStore(dir);
    assert.equal(reopened.getLatestCheckpoint(threadId)?.id, valid.id);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore checkpoint DB future version 在解析 payload 前 fail closed", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [{ role: "user", content: "goal" }]);
    const valid = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "summary" }],
      ...currentCompactionGuard(store, threadId),
      draft: checkpointDraft(),
    });
    store.close();

    const futureCheckpointId = "51aabf47-369d-40cd-b409-ae4c3f3e07bc";
    const database = new DatabaseSync(join(dir, "threads.db"));
    database
      .prepare(
        `INSERT INTO compaction_checkpoints
           (id, thread_id, generation, schema_version,
            message_from_sequence, message_through_sequence,
            tool_from_sequence, tool_through_sequence,
            checkpoint_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        futureCheckpointId,
        threadId,
        valid.generation + 1,
        99,
        valid.transcript.messages.throughSequence,
        valid.transcript.messages.throughSequence,
        valid.transcript.toolExecutions.throughSequence,
        valid.transcript.toolExecutions.throughSequence,
        "not-json",
        "2026-07-17T10:00:00.000Z",
      );
    database.close();

    const reopened = new ThreadStore(dir);
    const rejectsFutureVersion = (error: unknown): boolean =>
      error instanceof UnsupportedCompactionCheckpointVersionError &&
      error.checkpointVersion === 99;
    assert.throws(() => reopened.getLatestCheckpoint(threadId), rejectsFutureVersion);
    assert.throws(() => reopened.getLatestSummaryCheckpoint(threadId), rejectsFutureVersion);
    assert.throws(() => reopened.getCheckpoint(threadId, futureCheckpointId), rejectsFutureVersion);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore checkpoint DB/payload 版本不一致时按损坏的已知版本回退", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [{ role: "user", content: "goal" }]);
    const valid = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "summary" }],
      ...currentCompactionGuard(store, threadId),
      draft: checkpointDraft({
        summary: createCompactionSummary("Keep the grounded checkpoint as the recovery point."),
      }),
    });
    store.close();

    const mismatchedCheckpointId = "51aabf47-369d-40cd-b409-ae4c3f3e07bd";
    const database = new DatabaseSync(join(dir, "threads.db"));
    database
      .prepare(
        `INSERT INTO compaction_checkpoints
           (id, thread_id, generation, schema_version,
            message_from_sequence, message_through_sequence,
            tool_from_sequence, tool_through_sequence,
            checkpoint_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mismatchedCheckpointId,
        threadId,
        valid.generation + 1,
        1,
        valid.transcript.messages.throughSequence,
        valid.transcript.messages.throughSequence,
        valid.transcript.toolExecutions.throughSequence,
        valid.transcript.toolExecutions.throughSequence,
        JSON.stringify(valid),
        "2026-07-17T10:00:00.000Z",
      );
    database.close();

    const reopened = new ThreadStore(dir);
    assert.equal(reopened.getLatestCheckpoint(threadId)?.id, valid.id);
    assert.equal(reopened.getLatestSummaryCheckpoint(threadId)?.id, valid.id);
    assert.equal(reopened.getCheckpoint(threadId, mismatchedCheckpointId), undefined);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 两个连接追加 ToolExecutionRecord 时 sequence 单调且不冲突", () => {
  const dir = tempDir();
  try {
    const first = new ThreadStore(dir);
    const threadId = first.createThread();
    const second = new ThreadStore(dir);
    assert.equal(
      first.appendToolExecution(
        threadId,
        execution("3dd4fe14-355b-46d1-9f95-89a60e358c95", "first", "secret"),
      ),
      0,
    );
    assert.equal(
      second.appendToolExecution(
        threadId,
        execution("91a42f2f-522d-4b69-8869-bdd434454aef", "second", "secret"),
      ),
      1,
    );
    assert.deepEqual(
      first.listToolExecutions(threadId).map((record) => record.sequence),
      [0, 1],
    );
    second.close();
    first.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const RETENTION_CLOCK = { now: () => new Date("2026-08-20T00:00:00.000Z") } as const;

test("ThreadStore Runtime event log 跨重启保留 cursor 并从 null 或 cursor 恢复", () => {
  const dir = tempDir();
  try {
    const first = new ThreadStore(dir, RETENTION_CLOCK);
    const threadId = first.createThread();
    assert.equal(first.getRuntimeEventCursor(threadId), null);
    assert.deepEqual(first.resumeRuntimeEvents(threadId, null), {
      events: [],
      throughCursor: null,
      replayedCount: 0,
    });

    const started = first.appendRuntimeEvent({
      threadId,
      turnId: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-08-04T12:00:00+08:00",
      event: { type: "turn.started" },
    });
    const completed = first.appendRuntimeEvent({
      threadId,
      turnId: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-08-04T12:00:01+08:00",
      event: { type: "turn.completed" },
    });
    assert.equal(started.threadSequence, 0);
    assert.equal(completed.threadSequence, 1);
    assert.equal(first.getRuntimeEventCursor(threadId), completed.cursor);
    assert.deepEqual(
      first.resumeRuntimeEvents(threadId, started.cursor).events.map((event) => ({
        sequence: event.threadSequence,
        cursor: event.cursor,
        timestamp: event.timestamp,
        payload: event.event,
      })),
      [
        {
          sequence: 1,
          cursor: completed.cursor,
          timestamp: "2026-08-04T04:00:01.000Z",
          payload: { type: "turn.completed" },
        },
      ],
    );
    first.close();

    const reopened = new ThreadStore(dir, RETENTION_CLOCK);
    assert.equal(reopened.getRuntimeEventCursor(threadId), completed.cursor);
    const replay = reopened.resumeRuntimeEvents(threadId, null);
    assert.deepEqual(
      replay.events.map((event) => event.threadSequence),
      [0, 1],
    );
    assert.equal(replay.throughCursor, completed.cursor);
    assert.equal(replay.replayedCount, 2);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore Runtime event sequence 在两个连接间单调且 cursor 不混用", () => {
  const dir = tempDir();
  try {
    const first = new ThreadStore(dir, RETENTION_CLOCK);
    const firstThread = first.createThread();
    const secondThread = first.createThread();
    const second = new ThreadStore(dir, RETENTION_CLOCK);
    const firstEvent = first.appendRuntimeEvent({
      threadId: firstThread,
      timestamp: "2026-08-04T04:00:00.000Z",
      event: { type: "turn.started" },
    });
    const secondEvent = second.appendRuntimeEvent({
      threadId: firstThread,
      timestamp: "2026-08-04T04:00:01.000Z",
      event: { type: "turn.completed" },
    });
    assert.deepEqual([firstEvent.threadSequence, secondEvent.threadSequence], [0, 1]);

    const foreignCursor = second.appendRuntimeEvent({
      threadId: secondThread,
      timestamp: "2026-08-04T04:00:02.000Z",
      event: { type: "turn.started" },
    }).cursor;
    assert.throws(
      () => first.resumeRuntimeEvents(firstThread, foreignCursor),
      RuntimeEventCursorGapError,
    );
    const [, eventLogId] = firstEvent.cursor.split(":");
    assert.ok(eventLogId !== undefined);
    assert.throws(
      () =>
        first.resumeRuntimeEvents(
          firstThread,
          `rte1:${eventLogId}:0:00000000-0000-4000-8000-000000000099` as RuntimeEventCursor,
        ),
      RuntimeEventCursorGapError,
    );
    assert.throws(
      () =>
        first.resumeRuntimeEvents(
          firstThread,
          "rte1:not-a-log:0:not-an-event" as RuntimeEventCursor,
        ),
      RuntimeEventCursorGapError,
    );
    second.close();
    first.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "ThreadStore Runtime event count retention 只裁连续前缀并区分 boundary 与 expired cursor",
  { timeout: 30_000 },
  () => {
    const dir = tempDir();
    try {
      const store = new ThreadStore(dir, RETENTION_CLOCK);
      const threadId = store.createThread();
      const first = store.appendRuntimeEvent({
        threadId,
        timestamp: "2026-08-04T04:00:00.000Z",
        event: { type: "turn.started" },
      });
      const second = store.appendRuntimeEvent({
        threadId,
        timestamp: "2026-08-04T04:00:00.000Z",
        event: { type: "turn.started" },
      });
      for (
        let index = 2;
        index < RUNTIME_EVENT_RETENTION_POLICY.maxRecordsPerThread + 2;
        index += 1
      ) {
        store.appendRuntimeEvent({
          threadId,
          timestamp: "2026-08-04T04:00:00.000Z",
          event: { type: "turn.started" },
        });
      }

      assert.equal(
        store.countRuntimeEvents(threadId),
        RUNTIME_EVENT_RETENTION_POLICY.maxRecordsPerThread,
      );
      assert.throws(
        () => store.resumeRuntimeEvents(threadId, null),
        RuntimeEventCursorExpiredError,
      );
      assert.throws(
        () => store.resumeRuntimeEvents(threadId, first.cursor),
        RuntimeEventCursorExpiredError,
      );
      const replay = store.resumeRuntimeEvents(threadId, second.cursor);
      assert.equal(replay.events[0]?.threadSequence, 2);
      assert.equal(replay.events.at(-1)?.threadSequence, 10_001);
      assert.equal(replay.replayedCount, RUNTIME_EVENT_RETENTION_POLICY.maxRecordsPerThread);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("ThreadStore Runtime event byte retention 保留不超过 16 MiB 的最新连续后缀", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir, RETENTION_CLOCK);
    const threadId = store.createThread();
    const payload = "x".repeat(9 * 1_024 * 1_024);
    const first = store.appendRuntimeEvent({
      threadId,
      timestamp: "2026-08-04T04:00:00.000Z",
      event: {
        type: "tool.completed",
        toolCallId: "large-call-1",
        agentName: "fixture-agent",
        toolName: "fixture-tool",
        display: payload,
      },
    });
    const second = store.appendRuntimeEvent({
      threadId,
      timestamp: "2026-08-04T04:00:01.000Z",
      event: {
        type: "tool.completed",
        toolCallId: "large-call-2",
        agentName: "fixture-agent",
        toolName: "fixture-tool",
        display: payload,
      },
    });

    assert.equal(store.countRuntimeEvents(threadId), 1);
    assert.throws(() => store.resumeRuntimeEvents(threadId, null), RuntimeEventCursorExpiredError);
    const replay = store.resumeRuntimeEvents(threadId, first.cursor);
    assert.equal(replay.replayedCount, 1);
    assert.equal(replay.events[0]?.cursor, second.cursor);
    assert.equal(store.getRuntimeEventCursor(threadId), second.cursor);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 拒绝单条超过 Runtime event byte retention 上限的记录", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir, RETENTION_CLOCK);
    const threadId = store.createThread();
    assert.throws(
      () =>
        store.appendRuntimeEvent({
          threadId,
          timestamp: "2026-08-04T04:00:00.000Z",
          event: {
            type: "tool.completed",
            toolCallId: "oversized-call",
            agentName: "fixture-agent",
            toolName: "fixture-tool",
            display: "x".repeat(RUNTIME_EVENT_RETENTION_POLICY.maxBytesPerThread + 1),
          },
        }),
      /exceeds the per-Thread retained byte limit/u,
    );
    assert.equal(store.countRuntimeEvents(threadId), 0);
    assert.equal(store.getRuntimeEventCursor(threadId), null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore Runtime event age retention 遇到未过期记录后不在中间打洞", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir, RETENTION_CLOCK);
    const threadId = store.createThread();
    const events = [0, 1, 2].map(() =>
      store.appendRuntimeEvent({
        threadId,
        timestamp: "2026-08-04T04:00:00.000Z",
        event: { type: "turn.started" },
      }),
    );
    const database = new DatabaseSync(join(dir, "threads.db"));
    database
      .prepare(
        `UPDATE runtime_events
            SET created_at = '2026-06-01T00:00:00.000Z'
          WHERE thread_id = ? AND thread_sequence IN (0, 2)`,
      )
      .run(threadId);
    database.close();

    store.appendRuntimeEvent({
      threadId,
      timestamp: "2026-08-04T04:00:01.000Z",
      event: { type: "turn.completed" },
    });
    assert.equal(store.countRuntimeEvents(threadId), 3);
    assert.throws(() => store.resumeRuntimeEvents(threadId, null), RuntimeEventCursorExpiredError);
    assert.deepEqual(
      store
        .resumeRuntimeEvents(threadId, events[0]?.cursor ?? null)
        .events.map((event) => event.threadSequence),
      [1, 2, 3],
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore Runtime event resume 会裁剪静默 Thread 的过期前缀", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const retained = store.appendRuntimeEvent({
      threadId,
      timestamp: new Date().toISOString(),
      event: { type: "turn.started" },
    });
    const expiredAt = new Date(
      Date.now() - RUNTIME_EVENT_RETENTION_POLICY.maxAgeMs - 1_000,
    ).toISOString();
    const database = new DatabaseSync(join(dir, "threads.db"));
    database
      .prepare("UPDATE runtime_events SET created_at = ? WHERE thread_id = ?")
      .run(expiredAt, threadId);
    database.close();

    assert.throws(() => store.resumeRuntimeEvents(threadId, null), RuntimeEventCursorExpiredError);
    assert.equal(store.countRuntimeEvents(threadId), 0);
    assert.deepEqual(store.resumeRuntimeEvents(threadId, retained.cursor), {
      events: [],
      throughCursor: retained.cursor,
      replayedCount: 0,
    });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore 从 v4 升级只建立空 Runtime event log，不从旧 transcript 伪造事件", () => {
  const dir = tempDir();
  try {
    const initial = new ThreadStore(dir);
    const threadId = initial.createThread();
    initial.appendMessages(threadId, [
      { role: "user", content: "legacy goal" },
      { role: "assistant", content: "legacy answer" },
    ]);
    initial.close();

    const legacy = new DatabaseSync(join(dir, "threads.db"));
    legacy.exec(`
      DROP TABLE runtime_events;
      DROP TABLE thread_runtime_event_state;
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const migrated = new ThreadStore(dir);
    assert.equal(migrated.countRuntimeEvents(threadId), 0);
    assert.equal(migrated.getRuntimeEventCursor(threadId), null);
    assert.equal(migrated.countTranscriptMessages(threadId), 2);
    migrated.close();

    const inspected = new DatabaseSync(join(dir, "threads.db"));
    const stateCount = inspected
      .prepare("SELECT COUNT(*) AS count FROM thread_runtime_event_state WHERE thread_id = ?")
      .get(threadId) as { readonly count: number };
    const version = inspected.prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    assert.equal(stateCount.count, 1);
    assert.equal(version.user_version, 7);
    inspected.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore deleteThread 级联删除 Runtime event state 与 ledger", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir, RETENTION_CLOCK);
    const threadId = store.createThread();
    store.appendRuntimeEvent({
      threadId,
      timestamp: "2026-08-04T04:00:00.000Z",
      event: { type: "turn.started" },
    });
    store.deleteThread(threadId);
    assert.equal(store.countRuntimeEvents(threadId), 0);
    store.close();

    const database = new DatabaseSync(join(dir, "threads.db"));
    const stateCount = database
      .prepare("SELECT COUNT(*) AS count FROM thread_runtime_event_state WHERE thread_id = ?")
      .get(threadId) as { readonly count: number };
    assert.equal(stateCount.count, 0);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    database.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore Runtime event append 失败会回滚 sequence 且不产生 cursor", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir, RETENTION_CLOCK);
    const threadId = store.createThread();
    const database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_runtime_event_insert
      BEFORE INSERT ON runtime_events
      BEGIN
        SELECT RAISE(ABORT, 'simulated runtime event persistence failure');
      END;
    `);
    database.close();

    assert.throws(
      () =>
        store.appendRuntimeEvent({
          threadId,
          timestamp: "2026-08-04T04:00:00.000Z",
          event: { type: "turn.started" },
        }),
      /simulated runtime event persistence failure/u,
    );
    assert.equal(store.countRuntimeEvents(threadId), 0);
    assert.equal(store.getRuntimeEventCursor(threadId), null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ThreadStore future schema 不会被静默降级", () => {
  const dir = tempDir();
  try {
    const database = new DatabaseSync(join(dir, "threads.db"));
    database.exec("PRAGMA user_version = 99;");
    database.close();
    assert.throws(() => new ThreadStore(dir), /schema v99/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
