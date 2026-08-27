import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXECUTOR_LIVENESS,
  INVOCATION_STATUSES,
  ScheduleStore,
  createIntervalTrigger,
  type ExecutorLiveness,
} from "@roll-agent/runtime";
import type { CompanionServiceController } from "../companion-host/service.ts";
import { acquireAgentLifecycleLock } from "../registry/process-manager.ts";
import { KILL_PROCESS_TREE_OUTCOMES } from "./executor-liveness.ts";
import { SCHEDULER_DAEMON_LOCK_NAME } from "./paths.ts";
import {
  rollbackInstallingWindowsSchedulerService,
  uninstallWindowsSchedulerService,
  type OpenedWindowsSchedulerServiceStore,
} from "./service.ts";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

function createSchedule(store: ScheduleStore, name: string, nowMs: number) {
  return store.createSchedule(
    {
      name,
      prompt: `run ${name}`,
      cwd: "/workspace",
      trigger: createIntervalTrigger("30m"),
      fireImmediately: true,
    },
    nowMs,
  );
}

function openTestStore(store: ScheduleStore) {
  return async () => ({ store, close: () => undefined });
}

test("Windows scheduler uninstall disables and stops before revoking owned claims", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    const store = new ScheduleStore(dir);
    createSchedule(store, "owned", NOW);
    createSchedule(store, "other", NOW + 1);
    const owned = store.claimDue({ workerId: "daemon-1001", nowMs: NOW + 1, limit: 1 })[0];
    const other = store.claimDue({ workerId: "inline-2001", nowMs: NOW + 1, limit: 1 })[0];
    assert.ok(owned);
    assert.ok(other);
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        assert.equal(store.getInvocation(owned.invocation.id)?.status, INVOCATION_STATUSES.failed);
        assert.equal(store.getInvocation(other.invocation.id)?.status, INVOCATION_STATUSES.claimed);
        events.push("uninstall");
      },
    };

    await uninstallWindowsSchedulerService({
      controller,
      openStore: openTestStore(store),
      dataDir: dir,
      now: () => NOW + 2,
    });

    assert.deepEqual(events, ["disable", "stop", "uninstall"]);
    assert.equal(
      store.beginInvocation(owned.invocation.id, owned.ownershipToken, NOW + 3),
      undefined,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall terminates and conditionally cancels only this daemon's running exec", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  const liveness = new Map<number, ExecutorLiveness>([
    [4242, EXECUTOR_LIVENESS.alive],
    [4343, EXECUTOR_LIVENESS.alive],
  ]);
  try {
    const store = new ScheduleStore(dir, {
      executorLiveness: (executor) => liveness.get(executor.pid) ?? EXECUTOR_LIVENESS.unknown,
    });
    createSchedule(store, "owned running", NOW);
    createSchedule(store, "other running", NOW + 1);
    const owned = store.claimDue({ workerId: "daemon-1001", nowMs: NOW + 1, limit: 1 })[0];
    const other = store.claimDue({ workerId: "inline-2001", nowMs: NOW + 1, limit: 1 })[0];
    assert.ok(owned);
    assert.ok(other);
    assert.ok(
      store.beginInvocation(owned.invocation.id, owned.ownershipToken, NOW + 2, {
        pid: 4242,
        startToken: "pst-v2:owned",
      }),
    );
    assert.ok(
      store.beginInvocation(other.invocation.id, other.ownershipToken, NOW + 2, {
        pid: 4343,
        startToken: "pst-v2:other",
      }),
    );
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        assert.equal(store.getInvocation(owned.invocation.id)?.status, INVOCATION_STATUSES.failed);
        assert.equal(store.getInvocation(other.invocation.id)?.status, INVOCATION_STATUSES.running);
        events.push("uninstall");
      },
    };

    await uninstallWindowsSchedulerService({
      controller,
      openStore: openTestStore(store),
      dataDir: dir,
      now: () => NOW + 3,
      terminateExecutor: async (executor) => {
        events.push(`terminate:${String(executor.pid)}`);
        liveness.set(executor.pid, EXECUTOR_LIVENESS.dead);
        return KILL_PROCESS_TREE_OUTCOMES.tree;
      },
      waitForExecutorExit: async (executor) => {
        events.push(`wait:${String(executor.pid)}`);
        return liveness.get(executor.pid) ?? EXECUTOR_LIVENESS.unknown;
      },
    });

    assert.deepEqual(events, ["disable", "stop", "terminate:4242", "wait:4242", "uninstall"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall idempotently closes a running row whose exec already exited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  let terminateCalls = 0;
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => EXECUTOR_LIVENESS.dead });
    createSchedule(store, "already stopped", NOW);
    const claim = store.claimDue({ workerId: "daemon-1001", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.ok(
      store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
        pid: 4444,
        startToken: "pst-v2:dead",
      }),
    );
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => undefined,
      stop: async () => undefined,
      uninstall: async () => undefined,
    };

    await uninstallWindowsSchedulerService({
      controller,
      openStore: openTestStore(store),
      dataDir: dir,
      now: () => NOW + 2,
      terminateExecutor: async () => {
        terminateCalls += 1;
        return KILL_PROCESS_TREE_OUTCOMES.tree;
      },
      waitForExecutorExit: async () => {
        throw new Error("already-dead exec must not enter the wait path");
      },
    });

    assert.equal(terminateCalls, 0);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall keeps the disabled task and live rows when cleanup is unverified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  const liveness = new Map<number, ExecutorLiveness>([
    [4545, EXECUTOR_LIVENESS.unknown],
    [4646, EXECUTOR_LIVENESS.alive],
  ]);
  try {
    const store = new ScheduleStore(dir, {
      executorLiveness: (executor) => liveness.get(executor.pid) ?? EXECUTOR_LIVENESS.unknown,
    });
    createSchedule(store, "unknown exec", NOW);
    createSchedule(store, "failed taskkill", NOW + 1);
    const claims = store.claimDue({ workerId: "daemon-1001", nowMs: NOW + 1, limit: 2 });
    assert.equal(claims.length, 2);
    const [unknown, failedKill] = claims;
    assert.ok(unknown);
    assert.ok(failedKill);
    assert.ok(
      store.beginInvocation(unknown.invocation.id, unknown.ownershipToken, NOW + 2, {
        pid: 4545,
        startToken: "pst-v2:unknown",
      }),
    );
    assert.ok(
      store.beginInvocation(failedKill.invocation.id, failedKill.ownershipToken, NOW + 2, {
        pid: 4646,
        startToken: "pst-v2:failed",
      }),
    );
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await assert.rejects(
      uninstallWindowsSchedulerService({
        controller,
        openStore: openTestStore(store),
        dataDir: dir,
        now: () => NOW + 3,
        terminateExecutor: async (executor) => {
          events.push(`terminate:${String(executor.pid)}`);
          return KILL_PROCESS_TREE_OUTCOMES.failed;
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(unknown.invocation.id) &&
        error.message.includes(failedKill.invocation.id) &&
        error.message.includes("disabled"),
    );

    assert.deepEqual(events, ["disable", "stop", "terminate:4646"]);
    assert.equal(store.getInvocation(unknown.invocation.id)?.status, INVOCATION_STATUSES.running);
    assert.equal(
      store.getInvocation(failedKill.invocation.id)?.status,
      INVOCATION_STATUSES.running,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall rejects a failed tree kill even when the root later looks dead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  let liveness: ExecutorLiveness = EXECUTOR_LIVENESS.alive;
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
    createSchedule(store, "unconfirmed descendants", NOW);
    const claim = store.claimDue({ workerId: "daemon-1001", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.ok(
      store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
        pid: 4949,
        startToken: "pst-v2:root-only",
      }),
    );
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await assert.rejects(
      uninstallWindowsSchedulerService({
        controller,
        openStore: openTestStore(store),
        dataDir: dir,
        terminateExecutor: async () => {
          events.push("taskkill-failed");
          liveness = EXECUTOR_LIVENESS.dead;
          return KILL_PROCESS_TREE_OUTCOMES.failed;
        },
      }),
      /进程树未确认退出/u,
    );

    assert.deepEqual(events, ["disable", "stop", "taskkill-failed"]);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall also fences a replacement worker observed after stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => EXECUTOR_LIVENESS.dead });
    createSchedule(store, "old worker claim", NOW);
    createSchedule(store, "replacement worker run", NOW + 1);
    const oldClaim = store.claimDue({ workerId: "daemon-1001", nowMs: NOW + 1, limit: 1 })[0];
    const replacement = store.claimDue({
      workerId: "daemon-1002",
      nowMs: NOW + 1,
      limit: 1,
    })[0];
    assert.ok(oldClaim);
    assert.ok(replacement);
    assert.ok(
      store.beginInvocation(replacement.invocation.id, replacement.ownershipToken, NOW + 2, {
        pid: 5050,
        startToken: "pst-v2:replacement",
      }),
    );
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => undefined,
      stop: async () => undefined,
      uninstall: async () => {
        assert.equal(
          store.getInvocation(oldClaim.invocation.id)?.status,
          INVOCATION_STATUSES.failed,
        );
        assert.equal(
          store.getInvocation(replacement.invocation.id)?.status,
          INVOCATION_STATUSES.failed,
        );
      },
    };

    await uninstallWindowsSchedulerService({
      controller,
      openStore: openTestStore(store),
      dataDir: dir,
    });

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall discovers daemon work from the ledger when daemon identity is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    const store = new ScheduleStore(dir);
    createSchedule(store, "unattributed claim", NOW);
    const claim = store.claimDue({ workerId: "daemon-1001", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await uninstallWindowsSchedulerService({
      controller,
      openStore: openTestStore(store),
      dataDir: dir,
    });

    assert.deepEqual(events, ["disable", "stop", "uninstall"]);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall still cleans the ledger when the Scheduled Task is already missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => EXECUTOR_LIVENESS.dead });
    createSchedule(store, "missing task exec", NOW);
    const claim = store.claimDue({ workerId: "daemon-1001", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.ok(
      store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
        pid: 5151,
        startToken: "pst-v2:missing-task",
      }),
    );
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: false, running: false }),
      disable: async () => {
        throw new Error("missing task cannot be disabled");
      },
      stop: async () => {
        throw new Error("missing task does not need /End");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await uninstallWindowsSchedulerService({
      controller,
      openStore: openTestStore(store),
      dataDir: dir,
    });

    assert.deepEqual(events, ["uninstall"]);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall discovers an unreadable replacement worker from the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  let liveness: ExecutorLiveness = EXECUTOR_LIVENESS.alive;
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
    createSchedule(store, "stale recorded worker", NOW);
    createSchedule(store, "unreadable replacement", NOW + 1);
    const stale = store.claimDue({ workerId: "daemon-1001", nowMs: NOW + 1, limit: 1 })[0];
    const replacement = store.claimDue({
      workerId: "daemon-1002",
      nowMs: NOW + 1,
      limit: 1,
    })[0];
    assert.ok(stale);
    assert.ok(replacement);
    assert.ok(
      store.beginInvocation(replacement.invocation.id, replacement.ownershipToken, NOW + 2, {
        pid: 5252,
        startToken: "pst-v2:unreadable-replacement",
      }),
    );
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await uninstallWindowsSchedulerService({
      controller,
      openStore: openTestStore(store),
      dataDir: dir,
      terminateExecutor: async () => {
        liveness = EXECUTOR_LIVENESS.dead;
        return KILL_PROCESS_TREE_OUTCOMES.tree;
      },
      waitForExecutorExit: async () => liveness,
    });

    assert.deepEqual(events, ["disable", "stop", "uninstall"]);
    assert.equal(store.getInvocation(stale.invocation.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(
      store.getInvocation(replacement.invocation.id)?.status,
      INVOCATION_STATUSES.failed,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall fails closed while a manual daemon owns the lifecycle lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  const daemonLock = acquireAgentLifecycleLock(dir, SCHEDULER_DAEMON_LOCK_NAME);
  try {
    const store = new ScheduleStore(dir);
    createSchedule(store, "manual daemon claim", NOW);
    const claim = store.claimDue({ workerId: "daemon-1001", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await assert.rejects(
      uninstallWindowsSchedulerService({
        controller,
        openStore: openTestStore(store),
        dataDir: dir,
      }),
      /已有 roll schedule daemon/u,
    );

    assert.deepEqual(events, ["disable", "stop"]);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.claimed);
    store.close();
  } finally {
    daemonLock.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall disables and stops before opening a fallible ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    const store = new ScheduleStore(dir);
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: true }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await assert.rejects(
      uninstallWindowsSchedulerService({
        controller,
        dataDir: dir,
        openStore: async () => {
          events.push("open-store");
          throw new Error("ledger unreadable");
        },
      }),
      /ledger unreadable/u,
    );

    assert.deepEqual(events, ["disable", "stop", "open-store"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall does not kill a manual daemon when its Task is already missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  const daemonLock = acquireAgentLifecycleLock(dir, SCHEDULER_DAEMON_LOCK_NAME);
  try {
    const store = new ScheduleStore(dir);
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: false, running: false }),
      stop: async () => undefined,
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await assert.rejects(
      uninstallWindowsSchedulerService({
        controller,
        dataDir: dir,
        openStore: openTestStore(store),
      }),
      /已有 roll schedule daemon/u,
    );

    assert.deepEqual(events, []);
    store.close();
  } finally {
    daemonLock.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an installing service with no ledger rolls back only after acquiring the daemon fence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false, enabled: true }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await rollbackInstallingWindowsSchedulerService({
      controller,
      dataDir: dir,
      openStore: async () => {
        throw new Error("missing ledger must not be opened");
      },
      onUninstalled: () => {
        events.push("remove-state");
      },
    });

    assert.deepEqual(events, ["disable", "stop", "uninstall", "remove-state"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installing rollback switches to authoritative cleanup when the ledger appears during stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  let invocationId: string | undefined;
  try {
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: true, enabled: true }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
        const created = new ScheduleStore(dir);
        createSchedule(created, "appeared during stop", NOW);
        const claim = created.claimDue({ workerId: "daemon-1001", nowMs: NOW, limit: 1 })[0];
        assert.ok(claim);
        invocationId = claim.invocation.id;
        created.close();
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await rollbackInstallingWindowsSchedulerService({
      controller,
      dataDir: dir,
      openStore: async () => {
        events.push("open-store");
        const store = new ScheduleStore(dir, { requireExistingDatabase: true });
        return { store, close: () => store.close() };
      },
      onUninstalled: () => {
        events.push("remove-state");
      },
    });

    assert.deepEqual(events, ["disable", "stop", "open-store", "uninstall", "remove-state"]);
    assert.ok(invocationId);
    const check = new ScheduleStore(dir, { requireExistingDatabase: true });
    assert.equal(check.getInvocation(invocationId)?.status, INVOCATION_STATUSES.failed);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function passthroughStore(
  store: ScheduleStore,
  probeExecutor: OpenedWindowsSchedulerServiceStore["store"]["probeExecutor"],
): OpenedWindowsSchedulerServiceStore["store"] {
  return {
    listActiveWorkerInvocations: () => store.listActiveWorkerInvocations(),
    prepareWorkerShutdown: (workerId, reason, nowMs) =>
      store.prepareWorkerShutdown(workerId, reason, nowMs),
    probeExecutor,
    cancelInvocation: (id, reason, nowMs, options) =>
      store.cancelInvocation(id, reason, nowMs, options),
    getInvocation: (id) => store.getInvocation(id),
  };
}

test("Windows scheduler uninstall of an installed service without a ledger file deletes the task under the daemon fence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false, enabled: true }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await uninstallWindowsSchedulerService({
      controller,
      dataDir: dir,
      openStore: async () => {
        throw new Error("missing ledger must not be opened");
      },
      onUninstalled: () => {
        events.push("remove-state");
      },
    });

    assert.deepEqual(events, ["disable", "stop", "uninstall", "remove-state"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall treats a running row the exec released to retry mid-cleanup as handed off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => EXECUTOR_LIVENESS.dead });
    createSchedule(store, "released to retry", NOW);
    const claim = store.claimDue({ workerId: "daemon-1001", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.ok(
      store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
        pid: 6161,
        startToken: "pst-v2:released",
      }),
    );
    const wrapped = passthroughStore(store, (executor) => {
      events.push(`probe:${String(executor.pid)}`);
      store.failInvocation(claim.invocation.id, claim.ownershipToken, "exec 自行失败", NOW + 2);
      return store.probeExecutor(executor);
    });
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => undefined,
      stop: async () => undefined,
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await uninstallWindowsSchedulerService({
      controller,
      dataDir: dir,
      openStore: async () => ({ store: wrapped, close: () => undefined }),
      now: () => NOW + 3,
    });

    assert.deepEqual(events, ["probe:6161", "uninstall"]);
    const current = store.getInvocation(claim.invocation.id);
    assert.equal(current?.status, INVOCATION_STATUSES.retry);
    assert.equal(current?.claimedBy, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall refuses to finalize a row another daemon generation reclaimed mid-cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    let liveness: ExecutorLiveness = EXECUTOR_LIVENESS.alive;
    const store = new ScheduleStore(dir, { claimLeaseMs: 1, executorLiveness: () => liveness });
    createSchedule(store, "reclaimed", NOW);
    const stale = store.claimDue({ workerId: "daemon-1001", nowMs: NOW, limit: 1 })[0];
    assert.ok(stale);
    assert.ok(
      store.beginInvocation(stale.invocation.id, stale.ownershipToken, NOW + 1, {
        pid: 6262,
        startToken: "pst-v2:stale",
      }),
    );
    const wrapped = passthroughStore(store, (executor) => {
      liveness = EXECUTOR_LIVENESS.dead;
      const replacement = store.claimDue({
        workerId: "daemon-2002",
        nowMs: NOW + 10_000,
        limit: 1,
      })[0];
      assert.ok(replacement);
      assert.equal(replacement.invocation.id, stale.invocation.id);
      return store.probeExecutor(executor);
    });
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => undefined,
      stop: async () => undefined,
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await assert.rejects(
      uninstallWindowsSchedulerService({
        controller,
        dataDir: dir,
        openStore: async () => ({ store: wrapped, close: () => undefined }),
        now: () => NOW + 10_001,
      }),
      /重新接管/u,
    );

    assert.deepEqual(events, []);
    assert.equal(store.getInvocation(stale.invocation.id)?.claimedBy, "daemon-2002");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall re-checks the ledger and refuses when daemon work appears during cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    let liveness: ExecutorLiveness = EXECUTOR_LIVENESS.alive;
    const store = new ScheduleStore(dir, { executorLiveness: () => liveness });
    createSchedule(store, "running", NOW);
    const claim = store.claimDue({ workerId: "daemon-1001", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.ok(
      store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1, {
        pid: 6363,
        startToken: "pst-v2:running",
      }),
    );
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false }),
      disable: async () => undefined,
      stop: async () => undefined,
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await assert.rejects(
      uninstallWindowsSchedulerService({
        controller,
        dataDir: dir,
        openStore: openTestStore(store),
        now: () => NOW + 3,
        terminateExecutor: async () => KILL_PROCESS_TREE_OUTCOMES.tree,
        waitForExecutorExit: async () => {
          liveness = EXECUTOR_LIVENESS.dead;
          createSchedule(store, "late arrival", NOW + 4);
          const late = store.claimDue({ workerId: "daemon-3003", nowMs: NOW + 4, limit: 1 })[0];
          assert.ok(late);
          return EXECUTOR_LIVENESS.dead;
        },
      }),
      /仍为 live/u,
    );

    assert.deepEqual(events, []);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.failed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall of a service whose data-dir was deleted removes the task without recreating the directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    const dataDir = join(dir, "gone");
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false, enabled: true }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await uninstallWindowsSchedulerService({
      controller,
      dataDir,
      openStore: async () => {
        throw new Error("deleted data-dir must not be opened");
      },
      onUninstalled: () => {
        events.push("remove-state");
      },
    });

    assert.deepEqual(events, ["disable", "stop", "uninstall", "remove-state"]);
    assert.equal(existsSync(dataDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows scheduler uninstall explains how to recover from a present but invalid ledger file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-scheduler-stop-"));
  const events: string[] = [];
  try {
    writeFileSync(join(dir, "schedules.db"), "");
    const controller: CompanionServiceController = {
      install: async () => undefined,
      start: async () => undefined,
      status: async () => ({ installed: true, running: false, enabled: true }),
      disable: async () => {
        events.push("disable");
      },
      stop: async () => {
        events.push("stop");
      },
      uninstall: async () => {
        events.push("uninstall");
      },
    };

    await assert.rejects(
      uninstallWindowsSchedulerService({
        controller,
        dataDir: dir,
        openStore: async () => {
          const store = new ScheduleStore(dir, { requireExistingDatabase: true });
          return { store, close: () => store.close() };
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        /not a valid authoritative scheduler database/u.test(error.message) &&
        /移走或删除该文件/u.test(error.message),
    );

    assert.deepEqual(events, ["disable", "stop"]);
    assert.equal(existsSync(join(dir, "schedules.db")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
