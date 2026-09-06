import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ThreadStore, type CommitCompactionInput, type ThreadSnapshot } from "./thread-store.ts";
import { scheduledThreadOriginSchema } from "./thread-origin.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";
import {
  createEmptyCompactionToolState,
  createCompactionSummary,
} from "../engine/compaction-checkpoint.ts";
import {
  compactionSemanticStateSchema,
  createEmptyCompactionSemanticState,
} from "../engine/compaction-semantic-state.ts";

const origin = scheduledThreadOriginSchema.parse({
  kind: "scheduled",
  scheduleId: "schedule-a",
  invocationId: "run-a",
  attempt: 1,
  name: "Daily review",
  cwd: "/task-workspace",
  scheduledFor: "2026-09-05T09:00:00.000Z",
  ledgerDir: "/ledger",
});

function commitInput(store: ThreadStore, id: string): CommitCompactionInput {
  const snapshot = store.readSnapshot(id);
  return {
    expectedActiveMessages: snapshot.messages,
    expectedLatestCheckpointId: snapshot.checkpoints.at(-1)?.id,
    messages: [{ role: "user", content: "Compacted history" }],
    draft: {
      constraints: [],
      resources: [],
      toolState: createEmptyCompactionToolState(),
      runningWork: [
        {
          managerInstanceId: randomUUID(),
          sessionId: 1,
          state: "running",
          recoverability: "live",
          commandPreview: "long job",
          workdir: "/task-workspace",
          observedAt: new Date().toISOString(),
        },
      ],
      context: { cwd: "/task-workspace", stableRuleIds: [], skills: [], explicitSkillNames: [] },
      summary: createCompactionSummary(
        "The dependency review completed. Keep the exact task evidence and verify the remaining dependency upgrade before publishing.",
      ),
    },
    semanticState: createEmptyCompactionSemanticState(),
    semanticEvidenceWatermarks: { messagesThroughSequence: -1, toolExecutionsThroughSequence: -1 },
    evidenceWatermarks: {
      transcriptMessagesThroughSequence: snapshot.transcript.at(-1)?.sequence ?? -1,
      toolExecutionsThroughSequence: snapshot.toolExecutions.at(-1)?.sequence ?? -1,
    },
  };
}

test("thread origin is explicit, filter preserves all-list semantics, and exact legacy backfill leaves timestamps unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-origin-"));
  const store = new ThreadStore(dir);
  try {
    const interactive = store.createThread({ title: "[定时] user-written title" });
    const scheduled = store.createThread({ origin });
    const legacy = store.createThread();
    const db = new DatabaseSync(join(dir, "threads.db"));
    db.prepare("UPDATE threads SET origin_json = NULL WHERE id = ?").run(legacy);
    db.close();
    const before = store.getThread(legacy);
    assert.equal(before?.origin.kind, "interactive");
    assert.equal(store.backfillScheduledOrigin(legacy, origin), true);
    assert.equal(store.backfillScheduledOrigin(interactive, origin), false);
    assert.equal(
      store.backfillScheduledOrigin(legacy, { ...origin, invocationId: "wrong" }),
      false,
    );
    assert.equal(store.getThread(legacy)?.updatedAt, before?.updatedAt);
    assert.equal(store.getThread(legacy)?.createdAt, before?.createdAt);
    store.updateTitle(scheduled, "ordinary looking title");
    assert.deepEqual(store.getThread(scheduled)?.origin, origin);
    assert.equal(store.listThreads().length, 3);
    assert.deepEqual(
      store.listThreads({ origin: "interactive" }).map((thread) => thread.id),
      [interactive],
    );
    assert.equal(store.listThreads({ origin: "scheduled" }).length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only legacy v6 viewing cannot migrate, chmod, prune, write or create a missing source", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-readonly-"));
  const writer = new ThreadStore(dir);
  const id = writer.createThread();
  writer.appendMessages(id, [{ role: "user", content: "retained evidence" }]);
  const oldRecord = createToolExecutionRecord({
    id: randomUUID(),
    toolCallId: "retained",
    agentName: "demo",
    toolName: "lookup",
    input: {},
    result: successfulToolResult("old result"),
  });
  writer.appendToolExecution(id, oldRecord);
  writer.appendMessages(id, [{ role: "assistant", content: "old result" }], {
    toolExecutionCoverage: { executionIds: [oldRecord.id], representation: "recovery_evidence" },
  });
  writer.close();
  const path = join(dir, "threads.db");
  const db = new DatabaseSync(path);
  db.exec(
    "ALTER TABLE threads DROP COLUMN origin_json; ALTER TABLE threads DROP COLUMN derived_from_json; PRAGMA user_version = 6",
  );
  db.prepare("UPDATE tool_executions SET created_at = ?").run("2000-01-01T00:00:00.000Z");
  db.close();
  if (process.platform !== "win32") {
    chmodSync(dir, 0o755);
    chmodSync(path, 0o644);
  }
  const before = readFileSync(path);
  const beforeStat = statSync(path);
  try {
    const reader = new ThreadStore(dir, { readOnly: true });
    try {
      assert.equal(reader.getThread(id)?.origin.kind, "interactive");
      assert.equal(reader.listThreads({ origin: "scheduled" }).length, 0);
      assert.equal(reader.readSnapshot(id).transcript[0]?.message.content, "retained evidence");
      assert.equal(reader.readSnapshot(id).toolExecutions.length, 1);
      assert.throws(() => reader.createThread(), /readonly|read-only/iu);
    } finally {
      reader.close();
    }
    assert.deepEqual(readFileSync(path), before);
    assert.equal(statSync(path).mtimeMs, beforeStat.mtimeMs);
    assert.equal(statSync(path).mode, beforeStat.mode);
    if (process.platform !== "win32") assert.equal(statSync(dir).mode & 0o777, 0o755);
    assert.throws(() => new ThreadStore(join(dir, "absent"), { readOnly: true }));
    assert.equal(existsSync(join(dir, "absent")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot fork retains checkpoint ancestry, semantic references, archives, bounded tool evidence and coverage with independent events", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-fork-"));
  const source = new ThreadStore(join(dir, "source"));
  const target = new ThreadStore(join(dir, "target"));
  try {
    const id = source.createThread({ origin, model: "old-model" });
    const execution = createToolExecutionRecord({
      id: randomUUID(),
      toolCallId: "call-1",
      agentName: "demo",
      toolName: "lookup",
      input: { query: "dependencies" },
      result: successfulToolResult("2 updates", { raw: { token: "should-be-redacted" } }),
    });
    source.appendToolExecution(id, execution);
    source.appendMessages(
      id,
      [
        { role: "user", content: "Archived request" },
        { role: "assistant", content: "2 updates" },
      ],
      {
        toolExecutionCoverage: {
          executionIds: [execution.id],
          representation: "recovery_evidence",
        },
      },
    );
    const first = source.commitCompaction(id, commitInput(source, id));
    const secondInput = commitInput(source, id);
    const second = source.commitCompaction(id, {
      ...secondInput,
      draft: { ...secondInput.draft, summary: { status: "fallback", reason: "provider failed" } },
      semanticState: compactionSemanticStateSchema.parse({
        ...createEmptyCompactionSemanticState(),
        pendingWork: [
          {
            id: `semantic_pending_work_${"a".repeat(24)}`,
            text: "Check the saved result",
            provenance: [
              {
                kind: "legacy_snapshot",
                messageSequence: null,
                toolExecutionId: null,
                resourceKey: null,
                managerInstanceId: null,
                sessionId: null,
                checkpointId: first.id,
                snapshotIndex: 0,
              },
            ],
            sourceQuotes: [],
          },
        ],
      }),
    });
    source.appendRuntimeEvent({
      threadId: id,
      timestamp: new Date().toISOString(),
      event: { type: "turn.started" },
    });
    const snapshot = source.readSnapshot(id);
    const fork = target.forkSnapshot(snapshot, {
      model: "current-model",
    });
    const cloned = target.readSnapshot(fork);
    assert.equal(cloned.thread.origin.kind, "interactive");
    assert.deepEqual(cloned.thread.derivedFrom, {
      threadId: id,
      origin,
      capturedAt: snapshot.capturedAt,
    });
    assert.equal(cloned.thread.model, "current-model");
    assert.deepEqual(cloned.toolExecutions, snapshot.toolExecutions);
    assert.deepEqual(cloned.toolExecutionCoverage, snapshot.toolExecutionCoverage);
    assert.deepEqual(cloned.transcript.slice(0, snapshot.transcript.length), snapshot.transcript);
    assert.equal(target.listUncoveredToolExecutions(fork).length, 0);
    assert.equal(target.countRuntimeEvents(fork), 0);
    assert.equal(source.countRuntimeEvents(id), 1);
    const clonedFirst = cloned.checkpoints[0];
    const clonedSecond = cloned.checkpoints[1];
    assert.ok(clonedFirst && clonedSecond);
    assert.notEqual(clonedFirst.id, first.id);
    assert.notEqual(clonedSecond.id, second.id);
    assert.equal(clonedSecond.previousCheckpointId, clonedFirst.id);
    assert.equal(
      clonedSecond.summary.status === "fallback" && clonedSecond.summary.lastValidCheckpointId,
      clonedFirst.id,
    );
    assert.equal(
      clonedSecond.version === 2 &&
        clonedSecond.semanticState.pendingWork[0]?.provenance[0]?.checkpointId,
      clonedFirst.id,
    );
    assert.equal(clonedFirst.runningWork[0]?.recoverability, "unavailable");
    assert.equal(source.getCheckpoint(id, first.id)?.runningWork[0]?.recoverability, "live");
    assert.deepEqual(
      target
        .readCheckpointTranscript(fork, { checkpointId: clonedFirst.id, kind: "message" })
        .entries.map((entry) => entry.sequence),
      [0, 1],
    );
    assert.throws(() =>
      target.readCheckpointTranscript(fork, { checkpointId: first.id, kind: "message" }),
    );
    source.appendMessages(id, [{ role: "assistant", content: "later result" }]);
    assert.equal(
      target.getMessages(fork).some((message) => message.content === "later result"),
      false,
    );
    const next = target.commitCompaction(fork, commitInput(target, fork));
    assert.equal(next.generation, 3);
    assert.equal(next.previousCheckpointId, clonedSecond.id);
    source.deleteThread(id);
    assert.equal(
      target.readCheckpointTranscript(fork, {
        checkpointId: clonedFirst.id,
        kind: "tool_execution",
      }).entries.length,
      1,
    );
  } finally {
    source.close();
    target.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed snapshot imports roll back the new thread and all copied records", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-fork-rollback-"));
  const store = new ThreadStore(dir);
  try {
    const source = store.createThread({ origin });
    store.appendMessages(source, [{ role: "user", content: "old request" }]);
    const snapshot = store.readSnapshot(source);
    const invalid: ThreadSnapshot = {
      ...snapshot,
      toolExecutionCoverage: [
        {
          executionId: randomUUID(),
          representation: "raw_transcript",
          transcriptSequence: 0,
          createdAt: snapshot.capturedAt,
        },
      ],
    };
    const id = randomUUID();
    assert.throws(() => store.forkSnapshot(invalid, { id }), /FOREIGN KEY/iu);
    assert.equal(store.hasThread(id), false);
    assert.equal(store.listThreads().length, 1);
    assert.deepEqual({ ...store.readSnapshot(source), capturedAt: snapshot.capturedAt }, snapshot);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSnapshot pins all tables before a concurrent WAL writer commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-snapshot-wal-"));
  const writer = new ThreadStore(dir);
  const db = new DatabaseSync(join(dir, "threads.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.close();
  const id = writer.createThread({ origin });
  writer.appendMessages(id, [{ role: "user", content: "committed before capture" }]);
  const reader = new ThreadStore(dir, {
    readOnly: true,
    now: () => {
      writer.appendMessages(id, [{ role: "assistant", content: "committed during capture" }]);
      return new Date();
    },
  });
  try {
    const snapshot = reader.readSnapshot(id);
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.transcript.length, 1);
    assert.equal(writer.getMessages(id).length, 2);
  } finally {
    reader.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only opening handles escaped paths and never recreates a missing database", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-existing-"));
  const existing = join(dir, "spaces ? # 中文");
  const writer = new ThreadStore(existing);
  const id = writer.createThread();
  writer.close();
  try {
    const reopened = new ThreadStore(existing, { readOnly: true });
    assert.equal(reopened.hasThread(id), true);
    assert.throws(() => reopened.updateTitle(id, "must remain unchanged"), /readonly|read-only/iu);
    reopened.close();
    assert.throws(() => new ThreadStore(join(dir, "missing-directory"), { readOnly: true }));
    assert.equal(existsSync(join(dir, "missing-directory")), false);
    const path = join(existing, "threads.db");
    rmSync(path);
    assert.throws(() => new ThreadStore(existing, { readOnly: true }));
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
