import assert from "node:assert/strict";
import { once } from "node:events";
import fs, { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import type { SessionOwnershipHost } from "../host-contracts/session-ownership.ts";
import { SessionClaims, SessionOccupiedError } from "../ownership/session-claims.ts";
import { ThreadStore, inspectThreadLibrary } from "./thread-store.ts";
import { UnsupportedCompactionCheckpointVersionError } from "../engine/compaction-checkpoint.ts";

const ownership: SessionOwnershipHost = {
  identity: "opener",
  owner: { kind: "test", label: "opener" },
  probe: () => "alive",
};
const options = { ownership, migrateOnOpen: true };

function fixture(t: TestContext, version = 11) {
  const dir = mkdtempSync(join(tmpdir(), "roll-auto-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ThreadStore(dir);
  const id = store.createThread({ title: "legacy history" });
  store.appendMessages(id, [{ role: "user", content: "preserved" }]);
  store.close();
  const path = join(dir, "threads.db");
  const db = new DatabaseSync(path);
  db.exec(`ALTER TABLE threads DROP COLUMN workspace; PRAGMA user_version = ${String(version)}`);
  db.close();
  const backups = () => readdirSync(dir).filter((name) => name.includes(".backup-"));
  return { dir, id, path, backups };
}

for (const version of [7, 10, 11]) {
  test(`automatic open backs up schema ${version}, preserves history and only migrates once`, (t) => {
    const f = fixture(t, version);
    const store = new ThreadStore(f.dir, options);
    try {
      assert.equal(inspectThreadLibrary(f.dir).status, "current");
      assert.equal(store.getThread(f.id)?.workspace, undefined);
      assert.equal(store.readSnapshot(f.id).messages[0]?.content, "preserved");
      assert.ok(store.migrationBackupPath);
      const backup = new DatabaseSync(store.migrationBackupPath, { readOnly: true });
      try {
        assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, version);
        assert.equal(
          backup.prepare("SELECT title FROM threads WHERE id = ?").get(f.id)?.title,
          "legacy history",
        );
        assert.equal(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
      } finally {
        backup.close();
      }
    } finally {
      store.close();
    }
    const reopened = new ThreadStore(f.dir, options);
    assert.equal(reopened.migrationBackupPath, null);
    reopened.close();
    assert.equal(f.backups().length, 1);
  });
}

test("read-only opening never migrates even when automatic migration is requested", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.path);
  const reader = new ThreadStore(f.dir, { ...options, readOnly: true });
  assert.equal(reader.countMessages(f.id), 1);
  reader.close();
  assert.deepEqual(readFileSync(f.path), before);
  assert.deepEqual(f.backups(), []);
});

test("automatic migration cannot bypass session ownership through an unconfigured embedder", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.path);
  assert.throws(
    () => new ThreadStore(f.dir, { migrateOnOpen: true }),
    /requires session ownership/u,
  );
  assert.deepEqual(readFileSync(f.path), before);
  assert.deepEqual(f.backups(), []);
});

test("new and current automatic stores do not create a backup or run global retention", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "roll-new-auto-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 2; i++) {
    const store = new ThreadStore(dir, {
      ...options,
      now: () => {
        throw new Error("unexpected retention sweep");
      },
    });
    assert.equal(store.migrationBackupPath, null);
    store.close();
  }
  assert.equal(
    readdirSync(dir).some((name) => name.includes(".backup-")),
    false,
  );
});

for (const mode of ["delete", "wal"]) {
  test(`automatic backup excludes independent SQLite writes in ${mode} journal mode`, (t) => {
    const f = fixture(t);
    const contender = new DatabaseSync(f.path);
    contender.exec(`PRAGMA journal_mode=${mode}; PRAGMA busy_timeout=0;`);
    const prepare = DatabaseSync.prototype.prepare;
    let checked = false;
    const mock = t.mock.method(
      DatabaseSync.prototype,
      "prepare",
      function (this: DatabaseSync, sql: string) {
        if (sql === "VACUUM INTO ?") {
          assert.throws(() => contender.exec("BEGIN IMMEDIATE"), /locked|busy/u);
          checked = true;
        }
        return prepare.call(this, sql);
      },
    );
    try {
      const store = new ThreadStore(f.dir, options);
      store.close();
      assert.equal(checked, true);
      contender.exec("BEGIN IMMEDIATE; ROLLBACK;");
    } finally {
      mock.mock.restore();
      contender.close();
    }
  });
}

for (const version of [0, 99]) {
  test(`automatic opening refuses unrecognized schema ${version} without a backup or mutation`, (t) => {
    const f = fixture(t, version);
    const before = readFileSync(f.path);
    assert.throws(() => new ThreadStore(f.dir, options));
    assert.deepEqual(readFileSync(f.path), before);
    assert.deepEqual(f.backups(), []);
  });
}

for (const liveness of ["alive", "unknown"] as const) {
  test(`automatic migration preserves ${liveness} sibling ownership and succeeds after release`, (t) => {
    const f = fixture(t);
    const claims = new SessionClaims(f.path, { ...ownership, identity: "peer" });
    const hold = claims.acquire(f.id);
    try {
      const before = readFileSync(f.path);
      assert.throws(
        () =>
          new ThreadStore(f.dir, {
            ...options,
            ownership: { ...ownership, probe: () => liveness },
          }),
        SessionOccupiedError,
      );
      hold.assert();
      assert.deepEqual(readFileSync(f.path), before);
      assert.deepEqual(f.backups(), []);
      hold.release();
      const opened = new ThreadStore(f.dir, options);
      opened.close();
      assert.equal(f.backups().length, 1);
    } finally {
      hold.release();
      claims.close();
    }
  });
}

for (const phase of ["backup", "verification", "schema", "commit"] as const) {
  test(`a ${phase} failure preserves history and releases the gate for retry`, (t) => {
    const f = fixture(t);
    const before = readFileSync(f.path);
    const previousBackup = join(f.dir, "threads.db.backup-previous.sqlite");
    copyFileSync(f.path, previousBackup);
    const exec = DatabaseSync.prototype.exec;
    const prepare = DatabaseSync.prototype.prepare;
    let migrationDatabase: DatabaseSync | undefined;
    const execMock = t.mock.method(
      DatabaseSync.prototype,
      "exec",
      function (this: DatabaseSync, sql: string) {
        if (sql === "ALTER TABLE threads ADD COLUMN workspace TEXT") migrationDatabase = this;
        if (phase === "schema" && sql === "ALTER TABLE threads ADD COLUMN workspace TEXT") {
          throw new Error("injected schema failure");
        }
        if (phase === "commit" && sql === "COMMIT" && this === migrationDatabase) {
          throw new Error("injected commit failure");
        }
        return exec.call(this, sql);
      },
    );
    const prepareMock = t.mock.method(
      DatabaseSync.prototype,
      "prepare",
      function (this: DatabaseSync, sql: string) {
        if (
          (phase === "backup" && sql === "VACUUM INTO ?") ||
          (phase === "verification" && sql === "PRAGMA quick_check")
        ) {
          throw new Error(`injected ${phase} failure`);
        }
        return prepare.call(this, sql);
      },
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.throws(() => new ThreadStore(f.dir, options), /injected/u);
      assert.deepEqual(readFileSync(f.path), before);
      assert.deepEqual(f.backups(), ["threads.db.backup-previous.sqlite"]);
      assert.deepEqual(readFileSync(previousBackup), before);
    }
    execMock.mock.restore();
    prepareMock.mock.restore();
    const retry = new ThreadStore(f.dir, options);
    assert.equal(retry.countMessages(f.id), 1);
    retry.close();
    assert.equal(f.backups().length, 2);
  });
}

test("repeated rejection of an unsupported historical checkpoint does not accumulate backups", (t) => {
  const f = fixture(t, 8);
  const db = new DatabaseSync(f.path);
  db.prepare(
    `INSERT INTO compaction_checkpoints
    (id, thread_id, generation, schema_version, message_from_sequence, message_through_sequence,
     tool_from_sequence, tool_through_sequence, checkpoint_json, created_at)
    VALUES ('unsupported', ?, 1, 99, 0, 0, 0, 0, '{"version":99}', '2026-01-01T00:00:00Z')`,
  ).run(f.id);
  db.close();
  const before = readFileSync(f.path);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.throws(
      () => new ThreadStore(f.dir, options),
      UnsupportedCompactionCheckpointVersionError,
    );
    assert.deepEqual(readFileSync(f.path), before);
    assert.deepEqual(f.backups(), []);
  }
});

test("a backup that fails integrity validation is removed", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.path);
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql === "PRAGMA quick_check") {
      t.mock.method(statement, "all", () => [{ quick_check: "corrupt" }]);
    }
    return statement;
  });
  assert.throws(() => new ThreadStore(f.dir, options), /backup verification failed/u);
  assert.deepEqual(readFileSync(f.path), before);
  assert.deepEqual(f.backups(), []);
});

test("failed rollback preserves the verified backup and both errors", (t) => {
  const f = fixture(t);
  const exec = DatabaseSync.prototype.exec;
  const migrationFailure = new Error("injected migration failure");
  const rollbackFailure = new Error("injected rollback failure");
  let migrationDatabase: DatabaseSync | undefined;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "ALTER TABLE threads ADD COLUMN workspace TEXT") {
      migrationDatabase = this;
      throw migrationFailure;
    }
    if (sql === "ROLLBACK" && this === migrationDatabase) throw rollbackFailure;
    return exec.call(this, sql);
  });
  assert.throws(
    () => new ThreadStore(f.dir, options),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [migrationFailure, rollbackFailure]);
      return true;
    },
  );
  assert.equal(f.backups().length, 1);
  const name = f.backups()[0];
  assert.ok(name);
  const backup = new DatabaseSync(join(f.dir, name), { readOnly: true });
  try {
    assert.equal(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    backup.close();
  }
});

test("failed backup removal preserves the migration error and reports the retained path", (t) => {
  const f = fixture(t);
  const exec = DatabaseSync.prototype.exec;
  const migrationFailure = new Error("injected migration failure");
  const cleanupFailure = new Error("injected cleanup failure");
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "ALTER TABLE threads ADD COLUMN workspace TEXT") throw migrationFailure;
    return exec.call(this, sql);
  });
  const remove = t.mock.method(fs, "rmSync", () => {
    throw cleanupFailure;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => new ThreadStore(f.dir, options),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [migrationFailure, cleanupFailure]);
        assert.match(error.message, /\.backup-/u);
        return true;
      },
    );
    assert.equal(inspectThreadLibrary(f.dir).schemaVersion, 11);
  } finally {
    remove.mock.restore();
    syncBuiltinESMExports();
  }
});

function worker(source: string, workerData: unknown): Worker {
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData,
    execArgv: ["--experimental-strip-types", "--experimental-sqlite"],
  });
}

test(
  "concurrent automatic openers produce one backup and both open the upgraded library",
  { timeout: 20_000 },
  async (t) => {
    const f = fixture(t);
    const source = `
    import {workerData} from 'node:worker_threads';
    import {ThreadStore} from ${JSON.stringify(new URL("./thread-store.ts", import.meta.url).href)};
    Atomics.wait(new Int32Array(workerData.start),0,0);
    const store=new ThreadStore(workerData.dir,{migrateOnOpen:true,ownership:workerData.ownership ? {...workerData.ownership,probe:()=> 'alive'} : undefined});
    store.close();
  `;
    const start = new SharedArrayBuffer(4);
    const peers = ["a", "b"].map((identity) =>
      worker(source, { dir: f.dir, start, ownership: { identity, owner: ownership.owner } }),
    );
    const done = peers.map((peer) => once(peer, "exit"));
    try {
      Atomics.store(new Int32Array(start), 0, 1);
      Atomics.notify(new Int32Array(start), 0);
      for (const [code] of await Promise.all(done)) assert.equal(code, 0);
      assert.equal(f.backups().length, 1);
      assert.equal(inspectThreadLibrary(f.dir).status, "current");
    } finally {
      await Promise.all(peers.map((peer) => peer.terminate()));
    }
  },
);

test(
  "backup includes a concurrent SQLite writer committed before migration obtains its write lock",
  { timeout: 20_000 },
  async (t) => {
    const f = fixture(t);
    const writer = worker(
      `
    import {parentPort,workerData} from 'node:worker_threads';
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(workerData);
    db.exec("PRAGMA busy_timeout=15000; BEGIN IMMEDIATE; UPDATE threads SET title='concurrent commit';");
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);
    db.exec('COMMIT');db.close();
  `,
      f.path,
    );
    try {
      await once(writer, "message");
      const store = new ThreadStore(f.dir, options);
      try {
        assert.ok(store.migrationBackupPath);
        const backup = new DatabaseSync(store.migrationBackupPath, { readOnly: true });
        try {
          assert.equal(
            backup.prepare("SELECT title FROM threads WHERE id = ?").get(f.id)?.title,
            "concurrent commit",
          );
          assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, 11);
        } finally {
          backup.close();
        }
      } finally {
        store.close();
      }
    } finally {
      await writer.terminate();
    }
  },
);
