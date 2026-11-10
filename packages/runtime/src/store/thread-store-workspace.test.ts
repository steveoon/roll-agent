import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  inspectThreadLibrary,
  migrateThreadLibrary,
  THREAD_STORE_SCHEMA_VERSION,
  ThreadLibraryMigrationRequiredError,
  ThreadStore,
} from "./thread-store.ts";
import type { SessionOwnershipHost } from "../host-contracts/session-ownership.ts";
import { SessionOccupiedError } from "../ownership/session-claims.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";
import { scheduledThreadOriginSchema } from "./thread-origin.ts";

const ownership: SessionOwnershipHost = {
  identity: "workspace-test-owner",
  owner: { kind: "test", label: "Workspace tests" },
  probe: () => "alive",
};

test("workspace filters exclude another project's more recently updated conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-thread-workspace-"));
  const store = new ThreadStore(dir);
  try {
    const a = store.createThread({ workspace: "/project-a" });
    const legacy = store.createThread();
    const b = store.createThread({ workspace: "/project-b" });
    store.updateTitle(b, "B closed last");
    assert.equal(store.listThreads()[0]?.id, b);
    assert.deepEqual(
      store.listThreads({ workspace: "/project-a" }).map((t) => t.id),
      [a],
    );
    assert.deepEqual(
      store.listThreads({ workspace: null }).map((t) => t.id),
      [legacy],
    );
    assert.deepEqual(store.listThreads({ workspace: "/missing" }), []);
    assert.equal(store.getThread(a)?.workspace, "/project-a");
    assert.equal(store.readSnapshot(a).thread.workspace, "/project-a");
    assert.throws(() => store.createThread({ workspace: "" }));
    assert.throws(() => store.createThread({ workspace: "x".repeat(4097) }));
    assert.equal(store.listThreads().length, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v11 history stays read-only and unclassified until an explicit backed-up migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-v11-workspace-"));
  let store: ThreadStore | undefined;
  try {
    store = new ThreadStore(dir);
    const id = store.createThread({ title: "legacy" });
    store.appendMessages(id, [{ role: "user", content: "keep old history" }]);
    store.close();
    store = undefined;
    const path = join(dir, "threads.db");
    const database = new DatabaseSync(path);
    database.exec("ALTER TABLE threads DROP COLUMN workspace; PRAGMA user_version = 11");
    database.close();
    const original = readFileSync(path);
    store = new ThreadStore(dir, { readOnly: true });
    assert.equal(store.getThread(id)?.workspace, undefined);
    assert.deepEqual(
      store.listThreads({ workspace: null }).map((t) => t.id),
      [id],
    );
    assert.deepEqual(store.listThreads({ workspace: "/current" }), []);
    assert.equal(store.readSnapshot(id).messages.length, 1);
    store.close();
    store = undefined;
    assert.deepEqual(readFileSync(path), original);
    assert.throws(() => new ThreadStore(dir, { ownership }), ThreadLibraryMigrationRequiredError);
    assert.equal(inspectThreadLibrary(dir).schemaVersion, 11);
    const result = migrateThreadLibrary({
      dir,
      ownership,
      confirmStoppedLegacyClients: true,
    });
    const backup = new DatabaseSync(result.backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, 11);
      assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count, 1);
    } finally {
      backup.close();
    }
    assert.equal(result.preflight.schemaVersion, THREAD_STORE_SCHEMA_VERSION);
    store = new ThreadStore(dir, { ownership });
    assert.equal(store.getThread(id)?.workspace, undefined);
    assert.equal(store.countMessages(id), 1);
    const current = store.createThread({ workspace: "/current" });
    assert.deepEqual(
      store.listThreads({ workspace: "/current" }).map((t) => t.id),
      [current],
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only workspace browsing reports a peer claim without taking or changing ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-workspace-browse-"));
  const writer = new ThreadStore(dir, { ownership });
  const id = writer.createThread({ workspace: "/project-a" });
  const claim = writer.retainThread(id);
  const sidecar = `${join(dir, "threads.db")}.occupancy.sqlite`;
  const original = readFileSync(sidecar);
  const reader = new ThreadStore(dir, { readOnly: true, ownershipProbe: ownership });
  const unknown = new ThreadStore(dir, { readOnly: true });
  try {
    assert.deepEqual(
      reader.listThreads({ workspace: "/project-a" }).map((t) => t.id),
      [id],
    );
    assert.deepEqual(reader.inspectSessionOccupancy(id), {
      status: "occupied",
      owner: ownership.owner,
    });
    assert.equal(unknown.inspectSessionOccupancy(id).status, "unknown");
    assert.deepEqual(readFileSync(sidecar), original);
    claim?.assert();
    claim?.release();
    assert.deepEqual(reader.inspectSessionOccupancy(id), { status: "available" });
  } finally {
    reader.close();
    unknown.close();
    claim?.release();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assigning unclassified history preserves its identity, timestamps and execution history after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-workspace-assign-"));
  let nowMs = Date.parse("2026-11-10T00:00:00.000Z");
  const now = () => new Date(nowMs);
  let store = new ThreadStore(dir, { now, ownership });
  try {
    const id = store.createThread({ title: "Existing conversation", model: "original-model" });
    store.appendMessages(id, [
      { role: "user", content: "Keep this historical request" },
      { role: "assistant", content: "Keep this historical response" },
    ]);
    store.appendToolExecution(
      id,
      createToolExecutionRecord({
        id: randomUUID(),
        toolCallId: "historical-tool-call",
        agentName: "fixture",
        toolName: "lookup",
        input: { query: "historical evidence" },
        result: successfulToolResult("Keep this historical tool result"),
      }),
    );
    store.commitCompaction(id, {
      messages: [{ role: "user", content: "Keep the active context" }],
      expectedActiveMessages: store.getMessages(id),
      expectedLatestCheckpointId: undefined,
      summary: "Keep the historical summary",
    });
    store.appendRuntimeEvent({
      threadId: id,
      timestamp: now().toISOString(),
      event: { type: "turn.started" },
    });
    const before = store.readSnapshot(id);
    const cursor = store.getRuntimeEventCursor(id);
    nowMs += 60_000;
    store.assignThreadWorkspace(id, "/current-project");
    nowMs += 60_000;
    store.assignThreadWorkspace(id, "/current-project");
    assert.notEqual(before.thread.updatedAt, now().toISOString());
    assert.deepEqual(store.readSnapshot(id), {
      ...before,
      capturedAt: now().toISOString(),
      thread: { ...before.thread, workspace: "/current-project" },
    });
    assert.equal(store.countRuntimeEvents(id), 1);
    assert.equal(store.getRuntimeEventCursor(id), cursor);
    assert.deepEqual(store.listThreads({ workspace: null }), []);
    assert.deepEqual(
      store.listThreads({ workspace: "/current-project" }).map((t) => t.id),
      [id],
    );
    store.close();
    store = new ThreadStore(dir, { now, ownership });
    assert.deepEqual(store.readSnapshot(id), {
      ...before,
      capturedAt: now().toISOString(),
      thread: { ...before.thread, workspace: "/current-project" },
    });
    assert.equal(store.countRuntimeEvents(id), 1);
    assert.equal(store.getRuntimeEventCursor(id), cursor);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace assignment cannot overwrite another project or modify scheduled, missing or invalid history", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-workspace-assign-invalid-"));
  const store = new ThreadStore(dir, { ownership });
  try {
    const legacy = store.createThread();
    const attributed = store.createThread({ workspace: "/original-project" });
    const scheduled = store.createThread({
      origin: scheduledThreadOriginSchema.parse({
        kind: "scheduled",
        scheduleId: "schedule-1",
        invocationId: "run-1",
        attempt: 1,
        name: "Historical scheduled run",
        cwd: "/task-workspace",
        scheduledFor: "2026-11-10T00:00:00.000Z",
        ledgerDir: "/ledger",
      }),
    });
    const before = store.listThreads();
    assert.throws(
      () => store.assignThreadWorkspace(attributed, "/current-project"),
      /归属|workspace/u,
    );
    assert.throws(
      () => store.assignThreadWorkspace(scheduled, "/current-project"),
      /定时|scheduled/u,
    );
    assert.throws(() => store.assignThreadWorkspace("missing", "/current-project"), /不存在/u);
    assert.throws(() => store.assignThreadWorkspace(legacy, ""));
    assert.throws(() => store.assignThreadWorkspace(legacy, "x".repeat(4097)));
    assert.deepEqual(store.listThreads(), before);
    const reader = new ThreadStore(dir, { readOnly: true });
    try {
      assert.throws(() => reader.assignThreadWorkspace(legacy, "/current-project"), /read-only/u);
    } finally {
      reader.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace assignment respects occupied and unverifiable peers and preserves a retained owner claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-workspace-assign-claims-"));
  const writer = new ThreadStore(dir, { ownership });
  const peer = new ThreadStore(dir, {
    ownership: { ...ownership, identity: "workspace-peer" },
  });
  const unknown = new ThreadStore(dir, {
    ownership: { ...ownership, identity: "workspace-unknown", probe: () => "unknown" },
  });
  const id = writer.createThread();
  const hold = writer.retainSession(id);
  try {
    assert.throws(() => peer.assignThreadWorkspace(id, "/peer-project"), SessionOccupiedError);
    assert.throws(() => unknown.assignThreadWorkspace(id, "/peer-project"), SessionOccupiedError);
    assert.equal(writer.getThread(id)?.workspace, undefined);
    writer.assignThreadWorkspace(id, "/current-project");
    hold?.assert();
    assert.throws(
      () => peer.updateTitle(id, "cannot steal a retained claim"),
      SessionOccupiedError,
    );
    hold?.release();
    peer.updateTitle(id, "released normally");
    assert.equal(peer.getThread(id)?.workspace, "/current-project");
  } finally {
    hold?.release();
    unknown.close();
    peer.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
