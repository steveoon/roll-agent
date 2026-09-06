import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import * as runtime from "@roll-agent/runtime";
import { rollConfigSchema } from "../config/schema.ts";
import { backfillScheduledThreads, createScheduleBrowserPort } from "./schedule-history.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-schedule-history-recovery-"));
  const config = rollConfigSchema.parse({
    llm: { defaultProvider: "mock", defaultModel: "mock", providers: { mock: { apiKey: "test" } } },
    ask: {},
    agents: { dataDir: join(root, "agents") },
    runtime: { threadsDir: join(root, "threads") },
    scheduler: { dataDir: join(root, "scheduler") },
  });
  const threads = new runtime.ThreadStore(config.runtime.threadsDir);
  const schedules = new runtime.ScheduleStore(config.scheduler.dataDir);
  const task = schedules.createSchedule(
    {
      name: "每日依赖检查",
      prompt: "检查依赖",
      cwd: root,
      trigger: runtime.createIntervalTrigger("1m"),
    },
    0,
  );
  const claim = schedules.claimDue({ workerId: "test", nowMs: 60_000, limit: 1 })[0];
  assert.ok(claim);
  schedules.beginInvocation(claim.invocation.id, claim.ownershipToken, 60_001);
  return {
    root,
    config,
    threads,
    schedules,
    task,
    claim,
    close() {
      threads.close();
      schedules.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const removal of ["task-removed", "invocation-pruned"] as const) {
  test(`interrupted provenance backfill recovers from retained reference after ${removal}`, async () => {
    const f = fixture();
    try {
      const threadId = f.threads.createThread({ title: "legacy execution" });
      f.threads.appendMessages(threadId, [{ role: "user", content: "preserved original request" }]);
      const raw = new DatabaseSync(join(f.config.runtime.threadsDir, "threads.db"));
      raw.prepare("UPDATE threads SET origin_json = NULL WHERE id = ?").run(threadId);
      raw.close();
      // Simulate a crash between committing the durable reference and marking the old thread.
      f.schedules.registerThreadReference({
        invocationId: f.claim.invocation.id,
        expectedAttempt: 1,
        ownershipToken: f.claim.ownershipToken,
        threadId,
        threadsDir: f.config.runtime.threadsDir,
      });
      f.schedules.completeInvocation({
        id: f.claim.invocation.id,
        ownershipToken: f.claim.ownershipToken,
        status: "completed",
        threadId,
        nowMs: 60_002,
      });
      if (removal === "task-removed") f.schedules.removeSchedule(f.task.id);
      else assert.ok(f.schedules.pruneInvocations(365 * 24 * 60 * 60 * 1_000) > 0);
      const beforeRun = runtime.readScheduleRun(
        f.config.scheduler.dataDir,
        f.claim.invocation.id,
      ).run;
      assert.ok(beforeRun);
      assert.equal(beforeRun.invocation, undefined);
      assert.equal(beforeRun.references.length, 1);
      const beforeThread = f.threads.getThread(threadId);
      const beforeMessages = f.threads.getMessages(threadId);
      backfillScheduledThreads(f.config, runtime, f.threads);
      backfillScheduledThreads(f.config, runtime, f.threads);
      const recovered = f.threads.getThread(threadId);
      assert.equal(recovered?.origin.kind, "scheduled");
      assert.equal(
        recovered?.origin.kind === "scheduled" && recovered.origin.invocationId,
        f.claim.invocation.id,
      );
      assert.equal(recovered?.title, beforeThread?.title);
      assert.equal(recovered?.createdAt, beforeThread?.createdAt);
      assert.equal(recovered?.updatedAt, beforeThread?.updatedAt);
      assert.deepEqual(f.threads.getMessages(threadId), beforeMessages);
      assert.equal(
        f.threads.listThreads({ origin: "interactive" }).some((thread) => thread.id === threadId),
        false,
      );
      assert.deepEqual(
        runtime.readScheduleRun(f.config.scheduler.dataDir, f.claim.invocation.id).run?.references,
        beforeRun.references,
      );
      const detail = await createScheduleBrowserPort({ config: f.config, runtime }).inspect(
        f.claim.invocation.id,
      );
      assert.equal(detail.sessionId, threadId);
      assert.equal(detail.status, null);
      assert.equal(detail.statusUnavailableReason, "ledger_missing");
      assert.equal(detail.canContinue, true);
    } finally {
      f.close();
    }
  });
}

test("failure before session registration still shows the known task name and directory", async () => {
  const f = fixture();
  try {
    f.schedules.failInvocation(
      f.claim.invocation.id,
      f.claim.ownershipToken,
      "provider initialization failed",
      60_002,
      { terminal: true },
    );
    const detail = await createScheduleBrowserPort({ config: f.config, runtime }).inspect(
      f.claim.invocation.id,
    );
    assert.equal(detail.taskName, f.task.name);
    assert.equal(detail.cwd, f.task.cwd);
    assert.equal(detail.error, "provider initialization failed");
    assert.equal(detail.sessionId, undefined);
    assert.equal(detail.canContinue, false);
    assert.match(detail.unavailableReason ?? "", /没有可追溯的会话关联/u);
  } finally {
    f.close();
  }
});
