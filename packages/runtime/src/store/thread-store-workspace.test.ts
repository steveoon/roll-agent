import assert from "node:assert/strict";
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
