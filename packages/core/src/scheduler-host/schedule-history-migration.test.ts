import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { openScheduleStore } from "../cli/commands/schedule-command-utils.ts";
import * as runtime from "@roll-agent/runtime";
import { rollConfigSchema } from "../config/schema.ts";
import { backfillScheduledThreads, createScheduleBrowserPort } from "./schedule-history.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-schedule-migration-"));
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "openai",
      defaultModel: "test",
      providers: { openai: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: join(root, "agents") },
    runtime: { threadsDir: join(root, "current") },
    scheduler: { dataDir: join(root, "ledger") },
  });
  const ledger = new runtime.ScheduleStore(config.scheduler.dataDir);
  const current = new runtime.ThreadStore(config.runtime.threadsDir);
  const normalId = current.createThread({ title: "正常对话" });
  const cwd = join(root, "task");
  mkdirSync(cwd);
  const task = ledger.createSchedule(
    {
      name: "历史任务",
      prompt: "任务内容",
      cwd,
      trigger: runtime.createIntervalTrigger("1m"),
      fireImmediately: true,
    },
    0,
  );
  const claim = ledger.claimDue({ workerId: "test", nowMs: 0, limit: 1 })[0];
  assert.ok(claim);
  ledger.beginInvocation(claim.invocation.id, claim.ownershipToken, 1);
  const originalDir = join(cwd, "threads");
  const original = new runtime.ThreadStore(originalDir);
  const threadId = original.createThread({ title: "旧版本执行会话" });
  original.appendMessages(threadId, [{ role: "user", content: "原始任务输入" }]);
  const updatedAt = original.getThread(threadId)?.updatedAt;
  original.close();
  const legacy = new DatabaseSync(join(originalDir, "threads.db"));
  legacy.prepare("UPDATE threads SET origin_json = NULL WHERE id = ?").run(threadId);
  legacy.close();
  const referenceInput = {
    invocationId: claim.invocation.id,
    expectedAttempt: 1,
    ownershipToken: claim.ownershipToken,
    threadId,
    threadsDir: originalDir,
  };
  return {
    root,
    config,
    ledger,
    current,
    normalId,
    cwd,
    task,
    claim,
    originalDir,
    threadId,
    updatedAt,
    referenceInput,
    complete() {
      ledger.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: "completed",
        threadId,
        nowMs: 2,
      });
    },
    close() {
      current.close();
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("startup migration does not recreate a removed registered thread store", () => {
  const f = fixture();
  try {
    f.ledger.registerThreadReference(f.referenceInput);
    f.complete();
    rmSync(f.originalDir, { recursive: true });
    assert.doesNotThrow(() => backfillScheduledThreads(f.config, runtime, f.current));
    assert.equal(existsSync(f.originalDir), false);
    assert.equal(existsSync(join(f.originalDir, "threads.db")), false);
    assert.equal(
      runtime.readScheduleRun(f.config.scheduler.dataDir, f.claim.invocation.id).run?.references[0]
        ?.threadsDir,
      f.originalDir,
    );
    assert.equal(f.current.getThread(f.normalId)?.title, "正常对话");
  } finally {
    f.close();
  }
});

test("one corrupt historical store does not prevent ordinary chat initialization", () => {
  const f = fixture();
  try {
    f.ledger.registerThreadReference(f.referenceInput);
    f.complete();
    writeFileSync(join(f.originalDir, "threads.db"), "not sqlite");
    assert.doesNotThrow(() => backfillScheduledThreads(f.config, runtime, f.current));
    assert.deepEqual(
      f.current.listThreads({ origin: "interactive" }).map((thread) => thread.id),
      [f.normalId],
    );
    assert.equal(
      runtime.readScheduleRun(f.config.scheduler.dataDir, f.claim.invocation.id).run?.references
        .length,
      1,
    );
  } finally {
    f.close();
  }
});

test("scheduler owner records task-relative references without upgrading the other workspace", async () => {
  const f = fixture();
  try {
    f.complete();
    writeFileSync(join(f.cwd, "roll.config.yaml"), "runtime:\n  threads-dir: ./threads\n");
    const port = createScheduleBrowserPort({ config: f.config, runtime });
    const detail = await port.inspect(f.claim.invocation.id);
    assert.equal(detail.sessionId, f.threadId);
    assert.equal(detail.canContinue, true);
    assert.equal(
      runtime.readScheduleRun(f.config.scheduler.dataDir, f.claim.invocation.id).run?.references
        .length,
      0,
      "read-only inspector must not perform a migration",
    );
    backfillScheduledThreads(f.config, runtime, f.current);
    backfillScheduledThreads(f.config, runtime, f.current);
    assert.equal(
      runtime.readScheduleRun(f.config.scheduler.dataDir, f.claim.invocation.id).run?.references
        .length,
      0,
    );
    const owner = openScheduleStore(f.config, runtime);
    owner.close();
    const reference = runtime.readScheduleRun(f.config.scheduler.dataDir, f.claim.invocation.id).run
      ?.references[0];
    assert.equal(reference?.threadsDir, realpathSync(f.originalDir));
    const migrated = new runtime.ThreadStore(f.originalDir, { readOnly: true });
    try {
      const thread = migrated.getThread(f.threadId);
      assert.equal(thread?.origin.kind, "interactive");
      assert.equal(thread?.title, "旧版本执行会话");
      assert.equal(thread?.updatedAt, f.updatedAt);
      assert.deepEqual(migrated.getMessages(f.threadId), [
        { role: "user", content: "原始任务输入" },
      ]);
    } finally {
      migrated.close();
    }
    const local = new runtime.ThreadStore(f.originalDir);
    try {
      backfillScheduledThreads(
        { ...f.config, runtime: { ...f.config.runtime, threadsDir: f.originalDir } },
        runtime,
        local,
      );
      assert.equal(local.getThread(f.threadId)?.origin.kind, "scheduled");
    } finally {
      local.close();
    }
    assert.equal(f.current.getThread(f.normalId)?.origin.kind, "interactive");
  } finally {
    f.close();
  }
});

test("real chat --list leaves v5 scheduler and foreign v6 threads byte-for-byte unchanged", () => {
  const f = fixture();
  try {
    f.complete();
    writeFileSync(join(f.cwd, "roll.config.yaml"), "runtime:\n  threads-dir: ./threads\n");
    writeFileSync(join(f.root, "roll.config.yaml"), JSON.stringify(f.config));
    const schedulerFile = join(f.config.scheduler.dataDir, "schedules.db");
    const sourceFile = join(f.originalDir, "threads.db");
    const scheduler = new DatabaseSync(schedulerFile);
    scheduler.exec("DROP TABLE schedule_thread_refs; PRAGMA user_version = 5;");
    scheduler.close();
    const source = new DatabaseSync(sourceFile);
    source.exec(
      "ALTER TABLE threads DROP COLUMN origin_json; ALTER TABLE threads DROP COLUMN derived_from_json; PRAGMA user_version = 6;",
    );
    source.close();
    const beforeLedger = readFileSync(schedulerFile);
    const beforeSource = readFileSync(sourceFile);
    const cli = new URL("../cli/index.ts", import.meta.url).pathname;
    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--experimental-sqlite", cli, "chat", "--list", "--json"],
      { cwd: f.root, encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /正常对话/u);
    assert.deepEqual(readFileSync(schedulerFile), beforeLedger);
    assert.deepEqual(readFileSync(sourceFile), beforeSource);
  } finally {
    f.close();
  }
});

test("chat can classify its own legacy conversation while keeping v5 scheduler read-only", () => {
  const f = fixture();
  try {
    const id = f.current.createThread({ title: "本地旧执行" });
    const local = new DatabaseSync(join(f.config.runtime.threadsDir, "threads.db"));
    local.prepare("UPDATE threads SET origin_json = NULL WHERE id = ?").run(id);
    local.close();
    f.ledger.completeInvocation({
      id: f.claim.invocation.id,
      ownershipToken: f.claim.ownershipToken,
      status: "completed",
      threadId: id,
      nowMs: 2,
    });
    const schedulerFile = join(f.config.scheduler.dataDir, "schedules.db");
    const scheduler = new DatabaseSync(schedulerFile);
    scheduler.exec("DROP TABLE schedule_thread_refs; PRAGMA user_version = 5;");
    scheduler.close();
    const before = readFileSync(schedulerFile);
    backfillScheduledThreads(f.config, runtime, f.current);
    assert.equal(f.current.getThread(id)?.origin.kind, "scheduled");
    assert.deepEqual(readFileSync(schedulerFile), before);
  } finally {
    f.close();
  }
});
