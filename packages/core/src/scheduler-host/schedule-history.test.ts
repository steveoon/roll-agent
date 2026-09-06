import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as runtime from "@roll-agent/runtime";
import { rollConfigSchema } from "../config/schema.ts";
import {
  createScheduleBrowserPort,
  backfillScheduledThreads,
  parseScheduleAttempt,
} from "./schedule-history.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-schedule-history-"));
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "anthropic",
      defaultModel: "test",
      providers: { anthropic: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: join(root, "agents") },
    runtime: { threadsDir: join(root, "threads") },
    scheduler: { dataDir: join(root, "scheduler") },
  });
  const schedules = new runtime.ScheduleStore(config.scheduler.dataDir);
  const threads = new runtime.ThreadStore(config.runtime.threadsDir);
  const schedule = schedules.createSchedule(
    { name: "检查", prompt: "检查", cwd: root, trigger: runtime.createIntervalTrigger("1m") },
    0,
  );
  const claim = schedules.claimDue({ workerId: "test", nowMs: 60_000, limit: 1 })[0];
  assert.ok(claim);
  schedules.beginInvocation(claim.invocation.id, claim.ownershipToken, 60_001);
  return {
    root,
    config,
    schedules,
    threads,
    schedule,
    claim,
    close() {
      threads.close();
      schedules.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("history viewing reads archived messages, keeps timestamps and survives task removal", async () => {
  const f = fixture();
  try {
    const id = f.threads.createThread({ title: "执行" });
    f.threads.appendMessages(id, [
      { role: "user", content: "原始问题" },
      { role: "assistant", content: "原始结果" },
    ]);
    f.threads.replaceMessages(id, [{ role: "user", content: "压缩后上下文" }]);
    f.schedules.registerThreadReference({
      invocationId: f.claim.invocation.id,
      expectedAttempt: 1,
      ownershipToken: f.claim.ownershipToken,
      threadId: id,
      threadsDir: f.config.runtime.threadsDir,
    });
    f.schedules.completeInvocation({
      id: f.claim.invocation.id,
      ownershipToken: f.claim.ownershipToken,
      status: "completed",
      threadId: id,
      outputExcerpt: "完成",
      nowMs: 60_010,
    });
    const before = f.threads.getThread(id)?.updatedAt;
    const dbMtime = statSync(join(f.config.runtime.threadsDir, "threads.db")).mtimeMs;
    const port = createScheduleBrowserPort({ config: f.config, runtime });
    assert.equal((await port.listTasks()).length, 1);
    const transcript = await port.readTranscript(f.claim.invocation.id, { attempt: 1, limit: 20 });
    assert.match(transcript.text, /原始问题/u);
    assert.match(transcript.text, /原始结果/u);
    assert.equal(f.threads.getThread(id)?.updatedAt, before);
    assert.equal(statSync(join(f.config.runtime.threadsDir, "threads.db")).mtimeMs, dbMtime);
    f.schedules.removeSchedule(f.schedule.id);
    assert.equal((await port.listTasks())[0]?.removed, true);
    const detail = await port.inspect(f.claim.invocation.id);
    assert.equal(detail.sessionId, id);
    assert.equal(detail.status, null);
    assert.equal(detail.statusUnavailableReason, "ledger_missing");
  } finally {
    f.close();
  }
});

test("missing source is visible and opening it never creates a database", async () => {
  const f = fixture();
  try {
    const missing = join(f.root, "does-not-exist");
    f.schedules.registerThreadReference({
      invocationId: f.claim.invocation.id,
      expectedAttempt: 1,
      ownershipToken: f.claim.ownershipToken,
      threadId: "missing",
      threadsDir: missing,
    });
    const detail = await createScheduleBrowserPort({ config: f.config, runtime }).inspect(
      f.claim.invocation.id,
    );
    assert.equal(detail.canContinue, false);
    assert.ok(detail.unavailableReason);
    assert.equal(existsSync(missing), false);
  } finally {
    f.close();
  }
});

test("legacy backfill uses ledger identity, preserves titles and timestamps, ignores title lookalikes", () => {
  const f = fixture();
  try {
    const id = f.threads.createThread({ title: "旧记录" });
    const manual = f.threads.createThread({ title: "[定时] 用户自己取的名字" });
    const legacy = new DatabaseSync(join(f.config.runtime.threadsDir, "threads.db"));
    legacy.prepare("UPDATE threads SET origin_json = NULL WHERE id = ?").run(id);
    legacy.close();
    f.schedules.completeInvocation({
      id: f.claim.invocation.id,
      ownershipToken: f.claim.ownershipToken,
      status: "completed",
      threadId: id,
      nowMs: 60_010,
    });
    const before = f.threads.getThread(id);
    backfillScheduledThreads(f.config, runtime, f.threads);
    backfillScheduledThreads(f.config, runtime, f.threads);
    assert.equal(f.threads.getThread(id)?.origin.kind, "scheduled");
    assert.equal(f.threads.getThread(id)?.title, before?.title);
    assert.equal(f.threads.getThread(id)?.updatedAt, before?.updatedAt);
    assert.equal(f.threads.getThread(manual)?.origin.kind, "interactive");
  } finally {
    f.close();
  }
});

test("attempt parsing rejects partial, fractional and unsafe numeric inputs", () => {
  assert.equal(parseScheduleAttempt(undefined), undefined);
  assert.equal(parseScheduleAttempt("2"), 2);
  for (const input of ["0", "-1", "2x", "1.2", "9007199254740992"]) {
    assert.throws(() => parseScheduleAttempt(input));
  }
});

test("previous-attempt detail does not borrow a later failure status", async () => {
  const f = fixture();
  try {
    const threadId = f.threads.createThread({ title: "第一次尝试" });
    f.schedules.registerThreadReference({
      invocationId: f.claim.invocation.id,
      expectedAttempt: 1,
      ownershipToken: f.claim.ownershipToken,
      threadId,
      threadsDir: f.config.runtime.threadsDir,
    });
    f.schedules.failInvocation(f.claim.invocation.id, f.claim.ownershipToken, "retry", 60_005);
    const retryAt = f.schedules.getInvocation(f.claim.invocation.id)?.retryAtMs;
    assert.ok(retryAt !== undefined);
    const retry = f.schedules.claimDue({ workerId: "retry-worker", nowMs: retryAt, limit: 1 })[0];
    assert.ok(retry);
    assert.equal(retry.invocation.id, f.claim.invocation.id);
    f.schedules.beginInvocation(retry.invocation.id, retry.ownershipToken, retryAt + 1);
    f.schedules.failInvocation(
      retry.invocation.id,
      retry.ownershipToken,
      "terminal failure",
      retryAt + 2,
      { terminal: true },
    );
    const detail = await createScheduleBrowserPort({ config: f.config, runtime }).inspect(
      retry.invocation.id,
      1,
    );
    assert.equal(detail.status, null);
    assert.equal(detail.statusUnavailableReason, "attempt_not_current");
    assert.equal(detail.mode, "scheduled");
  } finally {
    f.close();
  }
});
