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
import {
  SchedulerDaemon,
  URGENT_STOP_REASON,
  stopReasonFor,
  type SpawnedInvocation,
} from "./daemon.ts";

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

test("停止时先 SIGTERM，超过 grace 仍未退出则 SIGKILL", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "a", Date.now());
    const { logger, lines } = silentLogger();
    const signals: string[] = [];
    const controller = new AbortController();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      pollIntervalMs: 50,
      childTerminateGraceMs: 30,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            if (signal === "SIGKILL") {
              exit.resolve(null);
            }
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
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.ok(lines.some((line) => /SIGKILL/u.test(line)));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("子进程运行超过 maxRunMs 时被 SIGKILL 并记为失败", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = addDueSchedule(store, "a", Date.now());
    const { logger, lines } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      maxRunMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            exit.resolve(null);
          },
        };
      },
    });
    assert.equal(daemon.tick(), 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(signals, ["SIGKILL"]);
    assert.equal(daemon.runningCount, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.retry);
    assert.ok(lines.some((line) => /运行超过/u.test(line)));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick 会按保留策略清理终态运行记录", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { invocationRetentionPerSchedule: 1 });
    const schedule = store.createSchedule(
      { name: "a", prompt: "p", cwd: "/workspace", trigger: createIntervalTrigger("30m") },
      NOW,
    );
    for (const offset of [0, 1, 2]) {
      const queued = store.enqueueManualInvocation(schedule.id, NOW + offset);
      const claim = store.claimPendingInvocation(queued.id, "w", NOW + offset);
      assert.ok(claim);
      store.completeInvocation({
        id: queued.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + offset,
      });
    }
    const { logger, lines } = silentLogger();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW + 10,
      spawnInvocation: () => ({ exited: Promise.resolve(0), kill: () => undefined }),
    });
    assert.equal(daemon.tick(), 0);
    assert.equal(store.listInvocations(schedule.id).length, 1);
    assert.ok(lines.some((line) => /已清理 2 条/u.test(line)));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("时钟跳变让自己的 claim lease 过期后，tick 不会重复拉起同一个 invocation", async () => {
  const dir = tempDir();
  try {
    let now = NOW;
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000 });
    const schedule = addDueSchedule(store, "a");
    const { logger } = silentLogger();
    let spawnCount = 0;
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 2,
      logger,
      now: () => now,
      spawnInvocation: (): SpawnedInvocation => {
        spawnCount += 1;
        return { exited: new Promise(() => undefined), kill: () => undefined };
      },
    });
    assert.equal(daemon.tick(), 1);
    now = NOW + 60_000;
    assert.equal(daemon.tick(), 0);
    assert.equal(spawnCount, 1);
    assert.equal(daemon.runningCount, 1);
    const rows = store.listInvocations(schedule.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.attempt, 1);
    assert.ok((rows[0]?.leaseUntilMs ?? 0) > now);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不属于本 daemon 且运行超过 maxRunMs 的孤儿 exec 进程会被 terminateExecutor 处理", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "alive" });
    const schedule = addDueSchedule(store, "a");
    const claim = store.claimDue({ workerId: "old-daemon", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
      pid: 4242,
      startToken: "pst-v2:orphan",
    });
    const { logger, lines } = silentLogger();
    const terminated: number[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW + 120_000,
      maxRunMs: 60_000,
      terminateExecutor: (executor) => {
        terminated.push(executor.pid);
        return true;
      },
      spawnInvocation: () => ({ exited: Promise.resolve(0), kill: () => undefined }),
    });
    assert.equal(daemon.tick(), 0);
    assert.deepEqual(terminated, [4242]);
    assert.ok(lines.some((line) => /不属于本 daemon/u.test(line)));
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("停止后才退出的子进程不会再触碰已关闭的账本", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "a", Date.now());
    const { logger } = silentLogger();
    const controller = new AbortController();
    const exit = Promise.withResolvers<number | null>();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      pollIntervalMs: 50,
      childTerminateGraceMs: 10,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        return { exited: exit.promise, kill: () => undefined };
      },
    });
    const running = daemon.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await running;
    assert.equal(daemon.runningCount, 0);
    store.close();
    exit.resolve(null);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exec 根进程退出但进程树仍有存活成员时，daemon 不把 invocation 记为失败，保留 running", async () => {
  const dir = tempDir();
  try {
    let liveness: "descendants-alive" | "dead" = "descendants-alive";
    const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
    const schedule = addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const exit = Promise.withResolvers<number | null>();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
          pid: 4242,
          startToken: "pst-v2:root",
        });
        return { exited: exit.promise, kill: () => undefined };
      },
    });
    assert.equal(daemon.tick(), 1);
    exit.resolve(null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(daemon.runningCount, 0);
    const row = store.listInvocations(schedule.id)[0];
    assert.equal(row?.status, INVOCATION_STATUSES.running);
    assert.ok(lines.some((line) => /进程树仍有存活成员/u.test(line)));
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 300_000, limit: 5 }), []);
    liveness = "dead";
    const reclaimed = store.claimDue({ workerId: "w2", nowMs: NOW + 600_000, limit: 5 });
    assert.equal(reclaimed[0]?.invocation.id, row?.id);
    assert.equal(reclaimed[0]?.invocation.attempt, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Store 未注入探针时 daemon 对已记录 executor 的退出保持 fail-closed（不记失败、不重试）", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = addDueSchedule(store, "a");
    const { logger } = silentLogger();
    const exit = Promise.withResolvers<number | null>();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
          pid: 4242,
          startToken: "pst-v2:root",
        });
        return { exited: exit.promise, kill: () => undefined };
      },
    });
    assert.equal(daemon.tick(), 1);
    exit.resolve(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon 发出的进程树终止未被确认时，子进程退出后不记失败、不重试", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const exit = Promise.withResolvers<number | null>();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      maxRunMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        return {
          exited: exit.promise,
          kill: () => {
            exit.resolve(null);
            return "root-only";
          },
        };
      },
    });
    assert.equal(daemon.tick(), 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(daemon.runningCount, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.running);
    assert.ok(lines.some((line) => /未能整体终止/u.test(line)));
    assert.ok(lines.some((line) => /终止未被确认/u.test(line)));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM 阶段树终止失败但随后的 SIGKILL 整体终止成功时，退出后照常记失败并重试", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "dead" });
    const schedule = addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const exit = Promise.withResolvers<number | null>();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      childTerminateGraceMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
          pid: 4242,
          startToken: "pst-v2:root",
        });
        return {
          exited: exit.promise,
          kill: (signal) => {
            signals.push(signal ?? "SIGTERM");
            if (signal === "SIGKILL") {
              exit.resolve(null);
              return "tree-terminated";
            }
            return "failed";
          },
        };
      },
    });
    const controller = new AbortController();
    const running = daemon.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await running;
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.retry);
    assert.ok(lines.some((line) => /未能整体终止（failed）/u.test(line)));
    assert.ok(lines.some((line) => /已在后续 SIGKILL 中整体终止/u.test(line)));
    assert.equal(
      lines.some((line) => /终止未被确认/u.test(line)),
      false,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 停止时不发无效的 SIGTERM，grace 后直接整体终止", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "dead" });
    addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const exit = Promise.withResolvers<number | null>();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      platform: "win32",
      childTerminateGraceMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
          pid: 4242,
          startToken: "pst-v2:root",
        });
        return {
          exited: exit.promise,
          kill: (signal) => {
            signals.push(signal ?? "SIGTERM");
            exit.resolve(null);
            return "tree-terminated";
          },
        };
      },
    });
    const controller = new AbortController();
    const running = daemon.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const startedAt = Date.now();
    controller.abort();
    await running;
    assert.deepEqual(signals, ["SIGKILL"]);
    assert.ok(Date.now() - startedAt >= 15);
    assert.ok(lines.some((line) => /Windows 没有优雅终止信号/u.test(line)));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("紧急停止（Windows 控制台关闭）不等待 grace，立即整体终止并释放 daemon", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "dead" });
    addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const exit = Promise.withResolvers<number | null>();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      platform: "win32",
      childTerminateGraceMs: 5_000,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
          pid: 4242,
          startToken: "pst-v2:root",
        });
        return {
          exited: exit.promise,
          kill: (signal) => {
            signals.push(signal);
            exit.resolve(null);
            return "tree-terminated";
          },
        };
      },
    });
    const controller = new AbortController();
    const running = daemon.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const startedAt = Date.now();
    controller.abort(URGENT_STOP_REASON);
    await running;
    assert.ok(Date.now() - startedAt < 1_000);
    assert.deepEqual(signals, ["SIGKILL"]);
    assert.ok(lines.some((line) => /紧急停止/u.test(line)));
    assert.equal(daemon.runningCount, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopReasonFor：只有 Windows 上的 SIGHUP 触发紧急停止", () => {
  assert.equal(stopReasonFor("SIGHUP", "win32"), URGENT_STOP_REASON);
  assert.equal(stopReasonFor("SIGBREAK", "win32"), undefined);
  assert.equal(stopReasonFor("SIGINT", "win32"), undefined);
  assert.equal(stopReasonFor("SIGTERM", "win32"), undefined);
  assert.equal(stopReasonFor("SIGHUP", "darwin"), undefined);
  assert.equal(stopReasonFor("SIGHUP", "linux"), undefined);
});

test("紧急停止时子进程在 settle 窗口内未退出：释放 daemon 但记录保持 running", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "unknown" });
    const schedule = addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      platform: "win32",
      childTerminateGraceMs: 5_000,
      urgentStopSettleMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
          pid: 4242,
          startToken: "pst-v2:root",
        });
        return {
          exited: new Promise(() => {}),
          kill: (signal) => {
            signals.push(signal);
            return "tree-terminated";
          },
        };
      },
    });
    const controller = new AbortController();
    const running = daemon.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const startedAt = Date.now();
    controller.abort(URGENT_STOP_REASON);
    await running;
    assert.ok(Date.now() - startedAt < 1_000);
    assert.deepEqual(signals, ["SIGKILL"]);
    assert.equal(daemon.runningCount, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.running);
    assert.ok(lines.some((line) => /退出未确认/u.test(line)));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
