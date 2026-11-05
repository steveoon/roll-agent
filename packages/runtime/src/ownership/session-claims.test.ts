import assert from "node:assert/strict";
import { mkdtempSync, rmSync, linkSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SessionClaims, SessionOccupiedError } from "./session-claims.ts";
import type { SessionOwnershipHost } from "../host-contracts/session-ownership.ts";
import {
  ThreadStore,
  inspectThreadLibrary,
  migrateThreadLibrary,
  ThreadLibraryMigrationRequiredError,
  RuntimeEventCursorExpiredError,
} from "../store/thread-store.ts";

function host(
  identity: string,
  probe: SessionOwnershipHost["probe"] = () => "alive",
): SessionOwnershipHost {
  return { identity, owner: { kind: "test", label: identity }, probe };
}
function directory() {
  return mkdtempSync(join(tmpdir(), "roll-claims-"));
}

test("idle retained claim fences every mutable store path and temporary writes preserve it", () => {
  const dir = directory();
  const first = new ThreadStore(dir, { ownership: host("first") });
  const second = new ThreadStore(dir, { ownership: host("second") });
  const id = first.createThread();
  const hold = first.retainThread(id);
  try {
    first.updateTitle(id, "idle owner");
    for (const mutate of [
      () => second.updateTitle(id, "other"),
      () => second.updateModel(id, "other"),
      () => second.deleteThread(id),
      () => second.appendMessages(id, []),
      () => second.replaceMessages(id, []),
      () => second.recoverUncoveredToolExecutions(id, () => ({ role: "user", content: "x" })),
      () => second.acceptTurnInput(id, "input", { role: "user", content: "x" }),
    ]) {
      assert.throws(mutate, SessionOccupiedError);
    }
    assert.equal(second.getThread(id)?.title, "idle owner");
    const other = second.createThread();
    second.appendMessages(other, [{ role: "user", content: "other thread works" }]);
    assert.equal(first.countMessages(other), 1);
    assert.throws(() => first.close(), /unsettled/);
  } finally {
    hold?.release();
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown identity never expires; dead CAS reclaim fences stale writes and stale release", () => {
  const dir = directory();
  const old = new ThreadStore(dir, { ownership: host("old") });
  const id = old.createThread();
  const stale = old.retainThread(id);
  const unknown = new SessionClaims(
    join(dir, "threads.db"),
    host("unknown", () => "unknown"),
  );
  const replacement = new ThreadStore(dir, { ownership: host("new", () => "dead") });
  try {
    assert.throws(() => unknown.acquire(id), SessionOccupiedError);
    const next = replacement.retainThread(id);
    assert.throws(() => stale?.assert(), /两端请选择其一/);
    assert.throws(() => old.updateTitle(id, "stale write"), SessionOccupiedError);
    stale?.release();
    next?.assert();
    replacement.updateTitle(id, "successor");
    assert.equal(old.getThread(id)?.title, "successor");
    next?.release();
  } finally {
    stale?.release();
    old.close();
    replacement.close();
    unknown.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dead reaper compares observed generation after a concurrent successor enters", () => {
  const dir = directory();
  const a = new SessionClaims(join(dir, "threads.db"), host("a"));
  const old = a.acquire("thread");
  let next: ReturnType<SessionClaims["acquire"]> | undefined;
  const c = new SessionClaims(join(dir, "threads.db"), host("c"));
  const b = new SessionClaims(
    join(dir, "threads.db"),
    host("b", (identity) => {
      if (identity !== "a") return "alive";
      old.release();
      next = c.acquire("thread");
      return "dead";
    }),
  );
  try {
    assert.throws(() => b.acquire("thread"), SessionOccupiedError);
    next?.assert();
  } finally {
    old.release();
    next?.release();
    a.close();
    b.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maintenance excludes all thread claims and never removes another generation", () => {
  const dir = directory();
  const a = new SessionClaims(join(dir, "threads.db"), host("a"));
  const b = new SessionClaims(join(dir, "threads.db"), host("b"));
  const owner = a.acquire("one");
  assert.throws(() => b.maintenance(), SessionOccupiedError);
  owner.release();
  const gate = b.maintenance();
  assert.throws(() => a.acquire("two"), SessionOccupiedError);
  gate.release();
  const next = a.acquire("two");
  next.release();
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("symlink library aliases share claims; hardlinked writable journals are rejected", () => {
  const dir = directory();
  const alias = `${dir}-alias`;
  const first = new ThreadStore(dir, { ownership: host("first") });
  const id = first.createThread();
  const held = first.retainThread(id);
  symlinkSync(dir, alias, "dir");
  const second = new ThreadStore(alias, { ownership: host("second") });
  assert.throws(() => second.updateTitle(id, "alias"), SessionOccupiedError);
  second.close();
  held?.release();
  first.close();
  linkSync(join(dir, "threads.db"), join(dir, "hardlink.db"));
  assert.throws(() => new ThreadStore(dir, { ownership: host("third") }), SessionOccupiedError);
  rmSync(alias);
  rmSync(dir, { recursive: true, force: true });
});

test("read-only preflight never creates/migrates; upgrade requires gate and verified consistent backup", () => {
  const dir = directory();
  const missing = join(dir, "absent");
  assert.equal(inspectThreadLibrary(missing).status, "new");
  assert.deepEqual(readdirSync(dir), []);
  const original = new ThreadStore(dir);
  const id = original.createThread({ title: "preserve" });
  original.close();
  const db = new DatabaseSync(join(dir, "threads.db"));
  db.exec("PRAGMA user_version = 10");
  db.close();
  const bytes = readFileSync(join(dir, "threads.db"));
  assert.equal(inspectThreadLibrary(dir).status, "needs_migration");
  const readOnly = new ThreadStore(dir, { readOnly: true });
  assert.equal(readOnly.getThread(id)?.title, "preserve");
  readOnly.close();
  assert.deepEqual(readFileSync(join(dir, "threads.db")), bytes);
  assert.throws(
    () => new ThreadStore(dir, { ownership: host("normal") }),
    ThreadLibraryMigrationRequiredError,
  );
  assert.deepEqual(readFileSync(join(dir, "threads.db")), bytes);
  const claims = new SessionClaims(join(dir, "threads.db"), host("writer"));
  const hold = claims.acquire(id);
  assert.throws(
    () =>
      migrateThreadLibrary({ dir, ownership: host("upgrade"), confirmStoppedLegacyClients: true }),
    SessionOccupiedError,
  );
  hold.release();
  claims.close();
  const result = migrateThreadLibrary({
    dir,
    ownership: host("upgrade"),
    confirmStoppedLegacyClients: true,
  });
  assert.equal(result.preflight.status, "current");
  const backup = new DatabaseSync(result.backupPath, { readOnly: true });
  assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, 10);
  assert.equal(backup.prepare("SELECT title FROM threads WHERE id = ?").get(id)?.title, "preserve");
  backup.close();
  const upgraded = new ThreadStore(dir, { ownership: host("upgraded") });
  assert.equal(upgraded.getThread(id)?.title, "preserve");
  upgraded.close();
  const future = new DatabaseSync(join(dir, "threads.db"));
  future.exec("PRAGMA user_version = 99");
  future.close();
  assert.equal(inspectThreadLibrary(dir).status, "unsupported");
  assert.throws(
    () => new ThreadStore(dir, { ownership: host("normal") }),
    ThreadLibraryMigrationRequiredError,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("coordinated startup and read-only replay never prune a live sibling; owned open prunes lazily", () => {
  const dir = directory();
  let now = new Date("2000-01-01T00:00:00.000Z");
  const first = new ThreadStore(dir, { ownership: host("first"), now: () => now });
  const id = first.createThread();
  const hold = first.retainThread(id);
  first.appendRuntimeEvent({
    threadId: id,
    timestamp: now.toISOString(),
    event: { type: "turn.started" },
  });
  now = new Date("2026-11-04T00:00:00.000Z");
  const second = new ThreadStore(dir, { ownership: host("second"), now: () => now });
  const readOnly = new ThreadStore(dir, { readOnly: true, now: () => now });
  try {
    assert.equal(first.countRuntimeEvents(id), 1);
    const before = readFileSync(join(dir, "threads.db"));
    assert.throws(() => second.resumeRuntimeEvents(id, null), RuntimeEventCursorExpiredError);
    assert.throws(() => readOnly.resumeRuntimeEvents(id, null), RuntimeEventCursorExpiredError);
    assert.deepEqual(readFileSync(join(dir, "threads.db")), before);
    const own = first.retainSession(id);
    assert.equal(first.countRuntimeEvents(id), 0);
    own?.release();
  } finally {
    hold?.release();
    readOnly.close();
    second.close();
    first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
