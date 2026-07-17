import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelMessage } from "ai";
import { ThreadStore, type ReadCheckpointTranscriptOptions } from "./thread-store.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";
import {
  createCompactionSummary,
  createEmptyCompactionToolState,
  type CompactionCheckpointDraftInput,
} from "../engine/compaction-checkpoint.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-threads-"));
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
    createdAt: "2026-07-17T10:00:00.000Z",
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
    assert.deepEqual(second.getToolExecution(threadId, secondRecord.id), {
      ...secondRecord,
      sequence: 1,
    });
    assert.equal(second.listToolExecutions(threadId, { afterSequence: 0 }).length, 1);
    assert.equal(second.listToolExecutions(threadId, { toolCallId: "missing" }).length, 0);
    second.close();
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

test("ThreadStore deleteThread 级联删除 Tool execution ledger", () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendToolExecution(
      threadId,
      execution("079f687b-2ec1-4dc8-852f-221d9c59b8d5", "call-delete", "secret"),
    );
    store.deleteThread(threadId);
    assert.deepEqual(store.listToolExecutions(threadId), []);
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
      draft: checkpointDraft({
        goal: { verbatimRequest: "turn-1", sourceSequence: 0, status: "active" },
      }),
    });
    assert.equal(first.version, 1);
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
      draft: checkpointDraft({ summary: validSummary }),
    });
    const fallback = store.commitCompaction(threadId, {
      messages: [{ role: "user", content: "fallback projection" }],
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
    assert.equal(version.user_version, 3);
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
        99,
        0,
        0,
        -1,
        -1,
        JSON.stringify({ version: 99 }),
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
