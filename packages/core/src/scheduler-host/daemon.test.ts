import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INVOCATION_STATUSES,
  SCHEDULE_STATUSES,
  ScheduleStore,
  createIntervalTrigger,
  type ClaimedInvocation,
} from "@roll-agent/runtime";
import { SchedulerDaemon, type SpawnedInvocation } from "./daemon.ts";

const NOW = Date.parse("2026-08-25T09:00:00.000Z");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-daemon-"));
}

function silentLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message: string) => {
        lines.push(`info ${message}`);
      },
      error: (message: string) => {
        lines.push(`error ${message}`);
      },
    },
  };
}

function addDueSchedule(store: ScheduleStore, name: string, nowMs: number = NOW) {
  return store.createSchedule(
    {
      name,
      prompt: "p",
      cwd: "/workspace",
      trigger: createIntervalTrigger("30m"),
      fireImmediately: true,
    },
    nowMs,
  );
}

test("tick 为到期任务 spawn 子进程，子进程完成后 invocation 完成", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = addDueSchedule(store, "a");
    const { logger } = silentLogger();
    const spawned: ClaimedInvocation[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 2,
      logger,
      now: () => NOW,
      spawnInvocation: (claim) => {
        spawned.push(claim);
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW);
        store.completeInvocation({
          id: claim.invocation.id,
          ownershipToken: claim.ownershipToken,
          status: INVOCATION_STATUSES.completed,
          nowMs: NOW + 1,
          threadId: "t1",
        });
        return { exited: Promise.resolve(0), kill: () => undefined };
      },
    });
    assert.equal(daemon.tick(), 1);
    assert.equal(spawned[0]?.schedule.id, schedule.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(daemon.runningCount, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.completed);
    assert.equal(daemon.tick(), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick 受 maxConcurrentRuns 约束，子进程退出后才继续 claim", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "a");
    addDueSchedule(store, "b");
    const { logger } = silentLogger();
    const pending: Array<(code: number) => void> = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW);
        return {
          exited: new Promise<number | null>((resolve) => {
            pending.push((code) => {
              store.completeInvocation({
                id: claim.invocation.id,
                ownershipToken: claim.ownershipToken,
                status: INVOCATION_STATUSES.completed,
                nowMs: NOW + 1,
              });
              resolve(code);
            });
          }),
          kill: () => undefined,
        };
      },
    });
    assert.equal(daemon.tick(), 1);
    assert.equal(daemon.tick(), 0);
    assert.equal(daemon.runningCount, 1);
    pending[0]?.(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(daemon.runningCount, 0);
    assert.equal(daemon.tick(), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("子进程非零退出且未写结果时记为失败并进入重试", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      spawnInvocation: () => ({ exited: Promise.resolve(1), kill: () => undefined }),
    });
    assert.equal(daemon.tick(), 1);
    await new Promise((resolve) => setImmediate(resolve));
    const invocation = store.listInvocations(schedule.id)[0];
    assert.equal(invocation?.status, INVOCATION_STATUSES.retry);
    assert.match(invocation?.error ?? "", /code=1/u);
    assert.ok(lines.some((line) => line.startsWith("error")));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn 抛错时 invocation 立即记失败", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const schedule = addDueSchedule(store, "a");
    const { logger } = silentLogger();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      spawnInvocation: () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(daemon.tick(), 1);
    assert.equal(daemon.runningCount, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.paused);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run 在 abort 后终止子进程并退出", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "a", Date.now());
    const { logger } = silentLogger();
    let killed = false;
    const controller = new AbortController();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      pollIntervalMs: 50,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: () => {
            killed = true;
            exit.resolve(null);
          },
        };
      },
    });
    const running = daemon.run(controller.signal);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(daemon.runningCount, 1);
    } finally {
      controller.abort();
      await running;
    }
    assert.equal(killed, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
