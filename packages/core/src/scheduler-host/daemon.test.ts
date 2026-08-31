import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_STATUSES,
  INVOCATION_TREE_LIVENESS,
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

function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EPERM") {
      throw error;
    }
  }
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

function addDueSchedule(
  store: ScheduleStore,
  name: string,
  nowMs: number = NOW,
  options: { readonly maxRunMs?: number } = {},
) {
  return store.createSchedule(
    {
      name,
      prompt: "p",
      cwd: "/workspace",
      trigger: createIntervalTrigger("30m"),
      fireImmediately: true,
      ...(options.maxRunMs === undefined ? {} : { maxRunMs: options.maxRunMs }),
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
    removeTempDir(dir);
  }
});

test("tick 在 claim admission 被 service maintenance 挡住时不领取到期任务", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "blocked");
    const { logger } = silentLogger();
    let spawned = false;
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      claimDue: () => undefined,
      spawnInvocation: () => {
        spawned = true;
        return { exited: Promise.resolve(0), kill: () => undefined };
      },
    });

    assert.equal(daemon.tick(), 0);
    assert.equal(spawned, false);
    assert.equal(store.listActiveWorkerInvocations().length, 0);
    store.close();
  } finally {
    removeTempDir(dir);
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
    removeTempDir(dir);
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
    removeTempDir(dir);
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
    removeTempDir(dir);
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
      childTerminateGraceMs: 30,
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
    removeTempDir(dir);
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
      platform: "linux",
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
    removeTempDir(dir);
  }
});

test("停止时 exec 根进程先退出但后代仍活，仍对捕获的进程树升级 SIGKILL", async () => {
  const dir = tempDir();
  try {
    let liveness: "alive" | "descendants-alive" | "dead" = "alive";
    const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
    const schedule = addDueSchedule(store, "descendants");
    const { logger } = silentLogger();
    const signals: string[] = [];
    const exit = Promise.withResolvers<number | null>();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      platform: "linux",
      maxConcurrentRuns: 1,
      logger,
      childTerminateGraceMs: 20,
      spawnInvocation: (claim) => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now(), {
          pid: 4242,
          startToken: "pst-v2:descendants",
        });
        return {
          exited: exit.promise,
          kill: (signal) => {
            signals.push(signal);
            if (signal === "SIGTERM") {
              liveness = "descendants-alive";
              exit.resolve(null);
            } else {
              liveness = "dead";
            }
            return "tree-terminated";
          },
        };
      },
    });
    const stop = new AbortController();
    const running = daemon.run(stop.signal);
    const deadline = Date.now() + 1_000;
    while (daemon.runningCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop.abort();
    await running;
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(store.listActiveWorkerInvocations().length, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, "retry");
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("停止时无法读取 executor 账本则按 unknown fail-closed，不对 numeric PGID 发 SIGKILL", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = addDueSchedule(store, "unreadable-tree");
    const { logger } = silentLogger();
    const signals: string[] = [];
    const exit = Promise.withResolvers<number | null>();
    const originalGetInvocation = store.getInvocation.bind(store);
    let readsFail = false;
    store.getInvocation = (id) => {
      if (readsFail) {
        throw new Error("ledger temporarily unavailable");
      }
      return originalGetInvocation(id);
    };
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      platform: "linux",
      maxConcurrentRuns: 1,
      logger,
      childTerminateGraceMs: 20,
      spawnInvocation: (claim) => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now(), {
          pid: 4242,
          startToken: "pst-v2:unreadable",
        });
        return {
          exited: exit.promise,
          kill: (signal) => {
            signals.push(signal);
            if (signal === "SIGTERM") {
              readsFail = true;
              exit.resolve(null);
            }
            return "tree-terminated";
          },
        };
      },
    });
    const stop = new AbortController();
    const running = daemon.run(stop.signal);
    const deadline = Date.now() + 1_000;
    while (daemon.runningCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop.abort();
    await running;
    readsFail = false;

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("停止时 root 已退出但 executor 探活仍报 alive，不对可能复用的 numeric PGID 发 SIGKILL", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "alive" });
    const schedule = addDueSchedule(store, "alive-after-root-exit");
    const { logger } = silentLogger();
    const signals: string[] = [];
    const exit = Promise.withResolvers<number | null>();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      platform: "linux",
      maxConcurrentRuns: 1,
      logger,
      childTerminateGraceMs: 20,
      spawnInvocation: (claim) => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now(), {
          pid: 4242,
          startToken: "pst-v2:alive-after-exit",
        });
        return {
          exited: exit.promise,
          kill: (signal) => {
            signals.push(signal);
            if (signal === "SIGTERM") {
              exit.resolve(null);
            }
            return "tree-terminated";
          },
        };
      },
    });
    const stop = new AbortController();
    const running = daemon.run(stop.signal);
    const deadline = Date.now() + 1_000;
    while (daemon.runningCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop.abort();
    await running;

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("POSIX 子进程运行超过 maxRunMs 时先 SIGTERM，grace 后才 SIGKILL", async () => {
  const dir = tempDir();
  try {
    let liveness: "alive" | "dead" = "alive";
    const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
    const schedule = addDueSchedule(store, "a", Date.now());
    const { logger, lines } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      maxRunMs: 20,
      childTerminateGraceMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now(), {
          pid: 4242,
          startToken: "pst-v2:max-run",
        });
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            if (signal === "SIGKILL") {
              liveness = "dead";
              exit.resolve(null);
            }
          },
        };
      },
    });
    assert.equal(daemon.tick(), 1);
    const deadline = Date.now() + 1_000;
    while ((signals.length < 2 || daemon.runningCount !== 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(daemon.runningCount, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.retry);
    assert.match(store.listInvocations(schedule.id)[0]?.error ?? "", /运行超过/u);
    assert.ok(lines.some((line) => /运行超过/u.test(line)));
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("POSIX maxRun SIGTERM 期间完成协作清理时取消迟到的 SIGKILL", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "a", Date.now());
    const { logger } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      maxRunMs: 20,
      childTerminateGraceMs: 30,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            if (signal === "SIGTERM") {
              exit.resolve(null);
            }
          },
        };
      },
    });

    assert.equal(daemon.tick(), 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(daemon.runningCount, 0);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("POSIX maxRun 后 root 先退出但明确 descendants-alive，仍对捕获树升级 SIGKILL 后结算", async () => {
  const dir = tempDir();
  try {
    let liveness: "alive" | "descendants-alive" | "dead" = "alive";
    const store = new ScheduleStore(dir, { retryBudget: 1, executorLiveness: () => liveness });
    const schedule = addDueSchedule(store, "max-run-descendants", Date.now());
    const { logger } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      maxRunMs: 20,
      childTerminateGraceMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now(), {
          pid: 4242,
          startToken: "pst-v2:max-run-descendants",
        });
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            if (signal === "SIGTERM") {
              liveness = "descendants-alive";
              exit.resolve(null);
            } else {
              liveness = "dead";
            }
            return "tree-terminated";
          },
        };
      },
    });

    assert.equal(daemon.tick(), 1);
    const deadline = Date.now() + 1_000;
    while (
      (signals.length < 2 ||
        store.listInvocations(schedule.id)[0]?.status === INVOCATION_STATUSES.running) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("daemon max-run 后 exec 迟到写 completed，scheduled 仍按预算转 retry", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 2, retryBackoffMs: 1 });
    const schedule = addDueSchedule(store, "late-completed", Date.now());
    const { logger } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      maxRunMs: 20,
      childTerminateGraceMs: 30,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            if (signal === "SIGTERM") {
              store.completeInvocation({
                id: claim.invocation.id,
                ownershipToken: claim.ownershipToken,
                status: INVOCATION_STATUSES.completed,
                nowMs: Date.now(),
              });
              exit.resolve(0);
            }
            return "tree-terminated";
          },
        };
      },
    });

    assert.equal(daemon.tick(), 1);
    const deadline = Date.now() + 1_000;
    while (daemon.runningCount !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.retry);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.active);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("daemon timeout 回调后迟到收到退出事件时保留超时前写入的 completed", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const schedule = addDueSchedule(store, "on-time-completed", Date.now());
    const { logger } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      maxRunMs: 20,
      childTerminateGraceMs: 30,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        const exit = Promise.withResolvers<number | null>();
        setTimeout(() => {
          store.completeInvocation({
            id: claim.invocation.id,
            ownershipToken: claim.ownershipToken,
            status: INVOCATION_STATUSES.completed,
            nowMs: Date.now(),
            threadId: "on-time-thread",
          });
        }, 5);
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            if (signal === "SIGTERM") {
              exit.resolve(0);
            }
            return "tree-terminated";
          },
        };
      },
    });

    assert.equal(daemon.tick(), 1);
    const deadline = Date.now() + 1_000;
    while (daemon.runningCount !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.completed);
    assert.equal(store.listInvocations(schedule.id)[0]?.threadId, "on-time-thread");
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.active);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("daemon max-run 后 exec 迟到写 needs_confirmation，scheduled 预算耗尽仍 failed 并 pause", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const schedule = addDueSchedule(store, "late-confirmation", Date.now());
    const { logger } = silentLogger();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      maxRunMs: 20,
      childTerminateGraceMs: 30,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            if (signal === "SIGTERM") {
              store.completeInvocation({
                id: claim.invocation.id,
                ownershipToken: claim.ownershipToken,
                status: INVOCATION_STATUSES.needsConfirmation,
                pendingActions: ["agent.tool"],
                nowMs: Date.now(),
              });
              exit.resolve(0);
            }
            return "tree-terminated";
          },
        };
      },
    });

    assert.equal(daemon.tick(), 1);
    const deadline = Date.now() + 1_000;
    while (daemon.runningCount !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.paused);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("daemon max-run 后 manual 迟到成功按自身 maxAttempts 失败，不 pause schedule", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = store.createSchedule(
      {
        name: "manual-late-success",
        prompt: "p",
        cwd: "/workspace",
        trigger: createIntervalTrigger("30m"),
      },
      Date.now(),
    );
    store.enqueueManualInvocation(schedule.id, Date.now(), { maxAttempts: 1 });
    const { logger } = silentLogger();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      maxRunMs: 20,
      childTerminateGraceMs: 30,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            if (signal === "SIGTERM") {
              store.completeInvocation({
                id: claim.invocation.id,
                ownershipToken: claim.ownershipToken,
                status: INVOCATION_STATUSES.completed,
                nowMs: Date.now(),
              });
              exit.resolve(0);
            }
            return "tree-terminated";
          },
        };
      },
    });

    assert.equal(daemon.tick(), 1);
    const deadline = Date.now() + 1_000;
    while (daemon.runningCount !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.active);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("daemon timeout CAS 返回 tree-unsettled 时释放 host entry，保留 running 账本", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "unknown" });
    const schedule = addDueSchedule(store, "timeout-tree-unsettled", Date.now());
    store.reclassifyTimedOutInvocation = () => INVOCATION_FAILURE_OUTCOMES.treeUnsettled;
    const { logger, lines } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      maxRunMs: 20,
      childTerminateGraceMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now(), {
          pid: 4242,
          startToken: "pst-v2:timeout-tree-unsettled",
        });
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            if (signal === "SIGTERM") {
              exit.resolve(null);
            }
            return "tree-terminated";
          },
        };
      },
    });

    assert.equal(daemon.tick(), 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(daemon.runningCount, 0, lines.join("\n"));
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.running);
    assert.equal(
      lines.some((line) => /已按失败重分类/u.test(line)),
      false,
    );
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("Windows maxRun 保持立即 SIGKILL，不发送无效 SIGTERM", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "a", Date.now());
    const { logger } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "win32",
      maxRunMs: 20,
      childTerminateGraceMs: 30,
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
    store.close();
  } finally {
    removeTempDir(dir);
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
    removeTempDir(dir);
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
    removeTempDir(dir);
  }
});

test("超时孤儿 exec 只启动一次 SIGTERM → grace → SIGKILL 清理", async () => {
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
    const signals: Array<{ readonly pid: number; readonly signal: NodeJS.Signals }> = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      now: () => NOW + 120_000,
      maxRunMs: 60_000,
      childTerminateGraceMs: 10,
      terminateExecutor: (executor, signal) => {
        signals.push({ pid: executor.pid, signal });
        return "tree-terminated";
      },
      spawnInvocation: () => ({ exited: Promise.resolve(0), kill: () => undefined }),
    });
    assert.equal(daemon.tick(), 0);
    assert.equal(daemon.tick(), 0);
    assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(signals, [
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
    assert.ok(lines.some((line) => /不属于本 daemon/u.test(line)));
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    removeTempDir(dir);
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
    removeTempDir(dir);
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
    removeTempDir(dir);
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
    removeTempDir(dir);
  }
});

test("exec 已死但登记树未清时 daemon onExit 释放 host entry，停止续租后 Store 可复核并结算", async () => {
  const dir = tempDir();
  try {
    let now = NOW;
    let treeLiveness:
      | typeof INVOCATION_TREE_LIVENESS.unsettled
      | typeof INVOCATION_TREE_LIVENESS.settled = INVOCATION_TREE_LIVENESS.unsettled;
    const store = new ScheduleStore(dir, {
      retryBudget: 1,
      executorLiveness: () => "dead",
      treeLiveness: () => treeLiveness,
    });
    const schedule = addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const exit = Promise.withResolvers<number | null>();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => now,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
          pid: 4242,
          startToken: "pst-v2:root",
        });
        store.recordInvocationTree({
          id: claim.invocation.id,
          ownershipToken: claim.ownershipToken,
          trackedGroups: [{ pgid: 9001, leaderState: "unknown" }],
          unsettled: true,
          survivorPids: [9002],
        });
        return { exited: exit.promise, kill: () => undefined };
      },
    });
    assert.equal(daemon.tick(), 1);
    exit.resolve(1);
    await new Promise((resolve) => setImmediate(resolve));
    const row = store.listInvocations(schedule.id)[0];
    assert.equal(row?.status, INVOCATION_STATUSES.running);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.active);
    assert.ok(lines.some((line) => /登记的进程树未清干净/u.test(line)));
    assert.equal(daemon.runningCount, 0);
    const leaseUntilMs = row?.leaseUntilMs;
    assert.ok(leaseUntilMs !== undefined);
    now = leaseUntilMs - 1;
    assert.equal(daemon.tick(), 0);
    assert.equal(store.getInvocation(row?.id ?? "")?.leaseUntilMs, leaseUntilMs);
    now = leaseUntilMs + 1;
    treeLiveness = INVOCATION_TREE_LIVENESS.settled;
    const reclaimed = store.claimDue({ workerId: "w2", nowMs: now, limit: 1 });
    assert.deepEqual(reclaimed, []);
    assert.equal(store.getInvocation(row?.id ?? "")?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    removeTempDir(dir);
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
    removeTempDir(dir);
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
      platform: "linux",
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
    removeTempDir(dir);
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
    removeTempDir(dir);
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
    removeTempDir(dir);
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
    removeTempDir(dir);
  }
});

test("任务自带 maxRunMs 时按任务上限而不是 daemon 全局上限触发超时", async () => {
  const dir = tempDir();
  try {
    let liveness: "alive" | "dead" = "alive";
    const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
    const schedule = addDueSchedule(store, "long", Date.now(), { maxRunMs: 60_000 });
    const { logger, lines } = silentLogger();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      maxRunMs: 120_000,
      maxTimerDelayMs: 20,
      childTerminateGraceMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now(), {
          pid: 4242,
          startToken: "pst-v2:task-max-run",
        });
        const exit = Promise.withResolvers<number | null>();
        return {
          exited: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            if (signal === "SIGKILL") {
              liveness = "dead";
              exit.resolve(null);
            }
          },
        };
      },
    });
    assert.equal(daemon.tick(), 1);
    assert.ok(lines.some((line) => /触发 long/u.test(line) && /max-run=60000 ms/u.test(line)));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(daemon.runningCount, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.retry);
    assert.ok(lines.some((line) => /运行超过 60000 ms/u.test(line)));
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("超时孤儿清理同样按任务 maxRunMs 判断，未超过任务上限的孤儿不动", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "alive" });
    addDueSchedule(store, "long", NOW, { maxRunMs: 300_000 });
    const claim = store.claimDue({ workerId: "old-daemon", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
      pid: 4242,
      startToken: "pst-v2:orphan",
    });
    const { logger } = silentLogger();
    const signals: NodeJS.Signals[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      now: () => NOW + 120_000,
      maxRunMs: 60_000,
      childTerminateGraceMs: 10,
      terminateExecutor: (_executor, signal) => {
        signals.push(signal);
        return "tree-terminated";
      },
      spawnInvocation: () => ({ exited: Promise.resolve(0), kill: () => undefined }),
    });
    assert.equal(daemon.tick(), 0);
    assert.deepEqual(signals, []);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("读取任务 cap 失败时孤儿清理 fail-closed，不用 daemon 默认值提前终止", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "alive" });
    const schedule = addDueSchedule(store, "long", NOW, { maxRunMs: 21_600_000 });
    const claim = store.claimDue({ workerId: "old-daemon", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
      pid: 4242,
      startToken: "pst-v2:orphan",
    });

    const corrupt = new DatabaseSync(join(dir, "schedules.db"));
    corrupt
      .prepare("UPDATE schedules SET trigger_json = ? WHERE id = ?")
      .run('{"kind":"interval","everyMs":"broken"}', schedule.id);
    corrupt.close();

    const { logger, lines } = silentLogger();
    const signals: NodeJS.Signals[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      now: () => NOW + 7_200_000,
      maxRunMs: 3_600_000,
      childTerminateGraceMs: 10,
      terminateExecutor: (_executor, signal) => {
        signals.push(signal);
        return "tree-terminated";
      },
      spawnInvocation: () => ({ exited: Promise.resolve(0), kill: () => undefined }),
    });

    assert.equal(daemon.tick(), 0);
    assert.equal(daemon.tick(), 0);
    assert.deepEqual(signals, []);
    assert.equal(
      lines.filter(
        (line) =>
          /\u8bfb\u53d6 schedule/u.test(line) &&
          /\u8fd0\u884c\u4e0a\u9650\u5931\u8d25/u.test(line) &&
          /\u8df3\u8fc7\u5b64\u513f\u6e05\u7406/u.test(line),
      ).length,
      1,
    );
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("orphan 对应的 schedule 缺失时 cap 未知，fail-closed 不回退 daemon 默认值", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "alive" });
    const schedule = addDueSchedule(store, "missing", NOW, { maxRunMs: 21_600_000 });
    const claim = store.claimDue({ workerId: "old-daemon", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
      pid: 4242,
      startToken: "pst-v2:orphan",
    });
    const corrupt = new DatabaseSync(join(dir, "schedules.db"));
    corrupt.exec("PRAGMA foreign_keys = OFF");
    corrupt.prepare("DELETE FROM schedules WHERE id = ?").run(schedule.id);
    corrupt.close();

    const { logger, lines } = silentLogger();
    const signals: NodeJS.Signals[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      now: () => NOW + 7_200_000,
      maxRunMs: 3_600_000,
      childTerminateGraceMs: 10,
      terminateExecutor: (_executor, signal) => {
        signals.push(signal);
        return "tree-terminated";
      },
      spawnInvocation: () => ({ exited: Promise.resolve(0), kill: () => undefined }),
    });

    assert.equal(daemon.tick(), 0);
    assert.deepEqual(signals, []);
    assert.ok(lines.some((line) => /schedule .* 不存在/u.test(line) && /跳过孤儿清理/u.test(line)));
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test("admission 拒绝领取时 daemon 记一条可操作日志，恢复后再记一条，且不会每 tick 重复", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    let blocked = true;
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      platform: "linux",
      now: () => NOW,
      claimDue: (input) => (blocked ? undefined : store.claimDue(input)),
      spawnInvocation: () => ({ exited: new Promise(() => undefined), kill: () => undefined }),
    });
    assert.equal(daemon.tick(), 0);
    assert.equal(lines.filter((line) => /admission 连续拒绝领取/u.test(line)).length, 0);
    assert.equal(daemon.tick(), 0);
    assert.equal(daemon.tick(), 0);
    const refused = lines.filter((line) => /admission 连续拒绝领取/u.test(line));
    assert.equal(refused.length, 1);
    assert.match(refused[0] ?? "", /roll schedule service status/u);
    blocked = false;
    assert.equal(daemon.tick(), 1);
    assert.equal(lines.filter((line) => /admission 已恢复/u.test(line)).length, 1);
    blocked = true;
    assert.equal(daemon.tick(), 0);
    blocked = false;
    assert.equal(daemon.tick(), 0);
    assert.equal(lines.filter((line) => /admission 已恢复/u.test(line)).length, 1);
    store.close();
  } finally {
    removeTempDir(dir);
  }
});
