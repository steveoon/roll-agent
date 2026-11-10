import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SessionClaims, ThreadStore, inspectThreadLibrary } from "@roll-agent/runtime";
import { createSessionOwnershipHost } from "../runtime-host/session-ownership.ts";

function fixture(t: TestContext, version = 10) {
  const root = mkdtempSync(join(tmpdir(), "roll-session-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "历史 with spaces");
  const store = new ThreadStore(dir);
  const id = store.createThread({ title: "existing history" });
  store.appendMessages(id, [{ role: "user", content: "preserve this message" }]);
  store.close();
  const databasePath = join(dir, "threads.db");
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA user_version = ${String(version)}`);
  db.close();
  writeFileSync(
    join(root, "roll.config.yaml"),
    JSON.stringify({
      runtime: { threadsDir: dir },
      agents: { dataDir: join(root, "agents") },
      scheduler: { dataDir: join(root, "scheduler") },
    }),
  );
  const preload = join(root, "offline.mjs");
  writeFileSync(
    preload,
    'globalThis.fetch = async () => { throw new Error("No network in migration fixture"); };',
  );
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-sqlite",
        "--import",
        preload,
        fileURLToPath(new URL("./index.ts", import.meta.url)),
        ...args,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          NO_COLOR: "1",
          ROLL_EXPECTED_SESSION_LIBRARY: undefined,
        },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
  return { root, dir, id, databasePath, run };
}

test("old-library CLI listing stays read-only; unconfirmed migration never writes", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.databasePath);
  const files = readdirSync(f.dir);
  const listed = f.run("chat", "--list", "--all-projects", "--json");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /existing history/u);
  assert.deepEqual(readFileSync(f.databasePath), before);
  assert.deepEqual(readdirSync(f.dir), files);
  const refused = f.run("runtime", "migrate", "--json");
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /--confirm-stopped-clients/u);
  assert.equal(refused.stdout, "");
  assert.deepEqual(readFileSync(f.databasePath), before);
  assert.deepEqual(readdirSync(f.dir), files);
});

test("confirmed CLI migration backs up history, enables chat listing and is repeatable without LLM setup", (t) => {
  const f = fixture(t);
  const migrated = f.run("runtime", "migrate", "--confirm-stopped-clients", "--json");
  assert.equal(migrated.status, 0, migrated.stderr);
  const result = z
    .object({ backupPath: z.string(), preflight: z.object({ status: z.literal("current") }) })
    .parse(JSON.parse(migrated.stdout));
  const backup = new DatabaseSync(result.backupPath, { readOnly: true });
  try {
    assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, 10);
    assert.equal(
      backup.prepare("SELECT title FROM threads WHERE id = ?").get(f.id)?.title,
      "existing history",
    );
    assert.equal(
      backup.prepare("SELECT count(*) AS n FROM messages WHERE thread_id = ?").get(f.id)?.n,
      1,
    );
  } finally {
    backup.close();
  }
  assert.equal(inspectThreadLibrary(f.dir).status, "current");
  const listed = f.run("chat", "--list", "--all-projects", "--json");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /existing history/u);
  const files = readdirSync(f.dir);
  const repeated = f.run("runtime", "migrate", "--confirm-stopped-clients", "--json");
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(
    z.object({ backupPath: z.null() }).parse(JSON.parse(repeated.stdout)).backupPath,
    null,
  );
  assert.deepEqual(readdirSync(f.dir), files);
});

test("explicit threads-dir migrates only the selected library", (t) => {
  const f = fixture(t);
  const configured = fixture(t);
  writeFileSync(
    join(f.root, "roll.config.yaml"),
    JSON.stringify({ runtime: { threadsDir: configured.dir } }),
  );
  const before = readFileSync(configured.databasePath);
  const migrated = f.run("runtime", "migrate", "--threads-dir", f.dir, "--confirm-stopped-clients");
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(inspectThreadLibrary(f.dir).status, "current");
  assert.deepEqual(readFileSync(configured.databasePath), before);
});

test("CLI migration refuses live claims even with confirmation, then succeeds after release", (t) => {
  const f = fixture(t);
  const claims = new SessionClaims(f.databasePath, createSessionOwnershipHost());
  const hold = claims.acquire(f.id);
  try {
    const before = readFileSync(f.databasePath);
    const files = readdirSync(f.dir);
    const blocked = f.run("runtime", "migrate", "--confirm-stopped-clients");
    assert.equal(blocked.status, 1, blocked.stderr);
    hold.assert();
    assert.deepEqual(readFileSync(f.databasePath), before);
    assert.deepEqual(readdirSync(f.dir), files);
    hold.release();
    const retry = f.run("runtime", "migrate", "--confirm-stopped-clients");
    assert.equal(retry.status, 0, retry.stderr);
  } finally {
    hold.release();
    claims.close();
  }
});

test("future schemas remain untouched and a missing library is not created by migration", (t) => {
  const f = fixture(t, 99);
  const before = readFileSync(f.databasePath);
  const files = readdirSync(f.dir);
  const future = f.run("runtime", "migrate", "--confirm-stopped-clients");
  assert.equal(future.status, 1, future.stderr);
  assert.match(future.stderr, /unsupported/u);
  assert.deepEqual(readFileSync(f.databasePath), before);
  assert.deepEqual(readdirSync(f.dir), files);
  const rootFiles = readdirSync(f.root);
  const missing = f.run(
    "runtime",
    "migrate",
    "--threads-dir",
    join(f.root, "missing"),
    "--confirm-stopped-clients",
  );
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual(readdirSync(f.root), rootFiles);
});
