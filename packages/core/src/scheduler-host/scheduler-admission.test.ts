import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentLifecycleBusyError } from "../registry/process-manager.ts";
import {
  SCHEDULER_SERVICE_STATE_PHASES,
  SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
  schedulerServiceStatePath,
  writeSchedulerServiceState,
} from "./service-state.ts";
import {
  SCHEDULER_ADMISSION_REFUSALS,
  SCHEDULER_REPLACEMENT_OUTCOMES,
  SchedulerAdmissionBusyError,
  acquireSchedulerAdmissionLockWithRetry,
  admitSchedulerDaemonStart,
  createSchedulerClaimDue,
  replaceSchedulerServiceWithAdmission,
  tryWithSchedulerAdmissionLock,
  withSchedulerAdmissionLock,
} from "./scheduler-admission.ts";

const isolatedHome = mkdtempSync(join(tmpdir(), "roll-admission-home-"));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const missingStatePath = () =>
  join(mkdtempSync(join(tmpdir(), "roll-admission-state-")), "scheduler-service.json");

test("tryWithSchedulerAdmissionLock：service replacement 持锁时不执行 claim", () => {
  let called = false;
  const result = tryWithSchedulerAdmissionLock(
    "/scheduler",
    () => {
      called = true;
      return 1;
    },
    {
      acquire: () => {
        throw new AgentLifecycleBusyError("scheduler-admission");
      },
    },
  );

  assert.deepEqual(result, { acquired: false, reason: SCHEDULER_ADMISSION_REFUSALS.busy });
  assert.equal(called, false);
});

test("tryWithSchedulerAdmissionLock：claim 完成或抛错都释放短锁", () => {
  let releases = 0;
  const acquire = () => ({ release: () => (releases += 1) });
  const statePath = missingStatePath();
  assert.deepEqual(
    tryWithSchedulerAdmissionLock("/scheduler", () => 42, { acquire, statePath }),
    {
      acquired: true,
      value: 42,
    },
  );
  assert.equal(releases, 1);
  assert.throws(() =>
    tryWithSchedulerAdmissionLock(
      "/scheduler",
      () => {
        throw new Error("claim failed");
      },
      { acquire, statePath },
    ),
  );
  assert.equal(releases, 2);
});

test("withSchedulerAdmissionLock：破坏性 replacement 全程持锁，busy 时给出领域错误", async () => {
  let locked = false;
  let released = false;
  const value = await withSchedulerAdmissionLock(
    async () => {
      assert.equal(locked, true);
      assert.equal(released, false);
      await Promise.resolve();
      return "done";
    },
    {
      acquire: () => {
        locked = true;
        return { release: () => (released = true) };
      },
    },
  );
  assert.equal(value, "done");
  assert.equal(released, true);

  await assert.rejects(
    withSchedulerAdmissionLock(async () => undefined, {
      acquire: () => {
        throw new AgentLifecycleBusyError("scheduler-admission");
      },
    }),
    SchedulerAdmissionBusyError,
  );
});

test("replaceSchedulerServiceWithAdmission：同一把门禁下复核 live，并阻止 replacement 期间的新 claim", async () => {
  let held = false;
  const dependencies = {
    acquire: () => {
      if (held) throw new AgentLifecycleBusyError("scheduler-admission");
      held = true;
      return { release: () => (held = false) };
    },
  };
  let replaced = false;
  const result = await replaceSchedulerServiceWithAdmission(
    {
      force: false,
      countLive: async () => 0,
      replace: async () => {
        const concurrentClaim = tryWithSchedulerAdmissionLock(
          "/scheduler",
          () => "claimed",
          dependencies,
        );
        assert.deepEqual(concurrentClaim, {
          acquired: false,
          reason: SCHEDULER_ADMISSION_REFUSALS.busy,
        });
        replaced = true;
      },
    },
    dependencies,
  );

  assert.deepEqual(result, {
    outcome: SCHEDULER_REPLACEMENT_OUTCOMES.replaced,
    liveInvocations: 0,
  });
  assert.equal(replaced, true);
  assert.equal(held, false);
});

test("replaceSchedulerServiceWithAdmission：有 live 时拒绝，只有 force 才执行 replacement", async () => {
  const dependencies = { acquire: () => ({ release: () => undefined }) };
  let replacements = 0;
  const base = {
    countLive: async () => 2,
    replace: async () => {
      replacements += 1;
    },
  };

  assert.deepEqual(
    await replaceSchedulerServiceWithAdmission({ ...base, force: false }, dependencies),
    {
      outcome: SCHEDULER_REPLACEMENT_OUTCOMES.refusedLiveRuns,
      liveInvocations: 2,
    },
  );
  assert.equal(replacements, 0);
  assert.deepEqual(
    await replaceSchedulerServiceWithAdmission({ ...base, force: true }, dependencies),
    {
      outcome: SCHEDULER_REPLACEMENT_OUTCOMES.replaced,
      liveInvocations: 2,
    },
  );
  assert.equal(replacements, 1);
});

test("createSchedulerClaimDue：daemon 统一通过 admission lock 领取", () => {
  let claims = 0;
  const statePath = missingStatePath();
  const claimDue = createSchedulerClaimDue(
    "/scheduler",
    () => {
      claims += 1;
      return ["claim"];
    },
    {
      acquire: () => {
        throw new AgentLifecycleBusyError("scheduler-admission");
      },
      statePath,
    },
  );
  assert.deepEqual(claimDue({}), []);
  assert.equal(claims, 0);

  const allowed = createSchedulerClaimDue("/scheduler", () => ["claim"], {
    acquire: () => ({ release: () => undefined }),
    statePath,
  });
  assert.deepEqual(allowed({}), ["claim"]);
});

test("持久化 installing intent 在 replacement 进程崩溃后仍阻止 previous/target claim", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-admission-"));
  try {
    const previousDataDir = join(home, "ledger-a");
    const targetDataDir = join(home, "ledger-b");
    const statePath = schedulerServiceStatePath(home);
    writeSchedulerServiceState(statePath, {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      phase: SCHEDULER_SERVICE_STATE_PHASES.installing,
      dataDir: targetDataDir,
      maxConcurrentRuns: 2,
      generation: "replacement-generation",
      replacementFrom: {
        schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
        phase: SCHEDULER_SERVICE_STATE_PHASES.installed,
        dataDir: previousDataDir,
        maxConcurrentRuns: 2,
      },
    });
    let claims = 0;
    const dependencies = {
      statePath,
      acquire: () => ({ release: () => undefined }),
    };
    for (const dataDir of [previousDataDir, targetDataDir]) {
      const result = tryWithSchedulerAdmissionLock(
        dataDir,
        () => {
          claims += 1;
        },
        dependencies,
      );
      assert.deepEqual(result, {
        acquired: false,
        reason: SCHEDULER_ADMISSION_REFUSALS.serviceState,
      });
    }
    assert.equal(claims, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claim 获得全局锁后复核 installing intent，关闭 replacement 崩溃时序窗口", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-admission-"));
  try {
    const dataDir = join(home, "ledger");
    const statePath = schedulerServiceStatePath(home);
    const installed = {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      phase: SCHEDULER_SERVICE_STATE_PHASES.installed,
      dataDir,
      maxConcurrentRuns: 2,
      generation: "installed-generation",
    } as const;
    writeSchedulerServiceState(statePath, installed);
    let claims = 0;
    let releases = 0;
    const result = tryWithSchedulerAdmissionLock(
      dataDir,
      () => {
        claims += 1;
      },
      {
        statePath,
        acquire: () => {
          writeSchedulerServiceState(statePath, {
            ...installed,
            phase: SCHEDULER_SERVICE_STATE_PHASES.installing,
            generation: "replacement-generation",
            replacementFrom: installed,
          });
          return { release: () => (releases += 1) };
        },
      },
    );

    assert.deepEqual(result, {
      acquired: false,
      reason: SCHEDULER_ADMISSION_REFUSALS.serviceState,
    });
    assert.equal(claims, 0);
    assert.equal(releases, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("service metadata 无法解析时 admission 全局 fail-closed", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-admission-"));
  try {
    const statePath = schedulerServiceStatePath(home);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "not-json\n", "utf-8");
    let claims = 0;
    let acquisitions = 0;
    const result = tryWithSchedulerAdmissionLock(
      join(home, "any-ledger"),
      () => {
        claims += 1;
      },
      {
        statePath,
        acquire: () => {
          acquisitions += 1;
          return { release: () => undefined };
        },
      },
    );

    assert.deepEqual(result, {
      acquired: false,
      reason: SCHEDULER_ADMISSION_REFUSALS.serviceState,
    });
    assert.equal(claims, 0);
    assert.equal(acquisitions, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("不同 data-dir 的 daemon 共用用户级 admission lock，update 可一次阻止全部新 claim", () => {
  const roots: string[] = [];
  const dependencies = {
    lockRoot: "/global-roll-home",
    acquire: (root: string) => {
      roots.push(root);
      return { release: () => undefined };
    },
    statePath: missingStatePath(),
  };
  assert.equal(
    tryWithSchedulerAdmissionLock("/scheduler-a", () => "a", dependencies).acquired,
    true,
  );
  assert.equal(
    tryWithSchedulerAdmissionLock("/scheduler-b", () => "b", dependencies).acquired,
    true,
  );
  assert.deepEqual(roots, ["/global-roll-home", "/global-roll-home"]);
});

test("service daemon 只接受 metadata 中匹配的 generation；foreground startup 服从 admission", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-admission-"));
  try {
    const dataDir = join(home, "ledger");
    const statePath = schedulerServiceStatePath(home);
    writeSchedulerServiceState(statePath, {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      phase: SCHEDULER_SERVICE_STATE_PHASES.installing,
      dataDir,
      maxConcurrentRuns: 2,
      generation: "service-generation",
    });
    const busy = {
      statePath,
      acquire: () => {
        throw new AgentLifecycleBusyError("scheduler-admission");
      },
    };

    const started = { release: () => undefined };
    assert.equal(
      admitSchedulerDaemonStart(dataDir, "service-generation", () => started, busy),
      started,
    );
    assert.throws(
      () => admitSchedulerDaemonStart(dataDir, "stale-generation", () => started, busy),
      /generation/u,
    );
    assert.throws(
      () => admitSchedulerDaemonStart(dataDir, undefined, () => started, busy),
      SchedulerAdmissionBusyError,
    );

    let staleLockReleases = 0;
    assert.throws(
      () =>
        admitSchedulerDaemonStart(
          dataDir,
          "service-generation",
          () => {
            writeSchedulerServiceState(statePath, {
              schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
              phase: SCHEDULER_SERVICE_STATE_PHASES.installing,
              dataDir,
              maxConcurrentRuns: 2,
              generation: "new-generation",
            });
            return { release: () => (staleLockReleases += 1) };
          },
          { statePath },
        ),
      /generation/u,
    );
    assert.equal(staleLockReleases, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acquireSchedulerAdmissionLockWithRetry：短暂 busy 时重试，超过次数才抛 busy", async () => {
  let failures = 2;
  let acquired = 0;
  const dependencies = {
    statePath: missingStatePath(),
    acquire: () => {
      if (failures > 0) {
        failures -= 1;
        throw new AgentLifecycleBusyError("scheduler-admission");
      }
      acquired += 1;
      return { release: () => undefined };
    },
  };
  const lock = await acquireSchedulerAdmissionLockWithRetry(
    { attempts: 3, delayMs: 1 },
    dependencies,
  );
  lock.release();
  assert.equal(acquired, 1);
  await assert.rejects(
    acquireSchedulerAdmissionLockWithRetry(
      { attempts: 2, delayMs: 1 },
      {
        statePath: dependencies.statePath,
        acquire: () => {
          throw new AgentLifecycleBusyError("scheduler-admission");
        },
      },
    ),
    SchedulerAdmissionBusyError,
  );
});
