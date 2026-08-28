import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, createIntervalTrigger } from "@roll-agent/runtime";
import { AgentLifecycleBusyError } from "../../registry/process-manager.ts";
import {
  inspectSchedulerServiceState,
  schedulerServiceStatePath,
  writeSchedulerServiceState,
  type SchedulerServiceState,
} from "../../scheduler-host/service-state.ts";
import {
  assertSchedulerDaemonStopped,
  countSchedulerServiceBlockers,
  describeSchedulerServiceRestartRefusal,
  installSchedulerServiceGeneration,
  probeSchedulerService,
  retireWindowsSchedulerServiceIntent,
  schedulerServiceTeardownState,
} from "./schedule-service-utils.ts";

test("restart 拒绝文案不承诺 --force 会终止 inline invocation", () => {
  const message = describeSchedulerServiceRestartRefusal({
    action: "refuse-live-runs",
    liveInvocations: 2,
  });
  assert.match(message, /daemon-owned/u);
  assert.match(message, /inline 不受影响/u);
  assert.doesNotMatch(message, /中断这些运行/u);
});

test("Linux 未安装内建 service 时 probe 是正常 no-op，不让 doctor 永久告警", async () => {
  const probe = await probeSchedulerService({
    platform: "linux",
    statePath: join(mkdtempSync(join(tmpdir(), "roll-missing-state-")), "scheduler-service.json"),
  });
  assert.deepEqual(probe, {
    metadataStatus: "missing",
    installed: false,
    running: false,
  });
});

test("service generation 安装编排把同一 nonce 传给 OS 定义并等待 daemon record", async () => {
  const events: string[] = [];
  const controller = {
    install: async () => undefined,
    uninstall: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    status: async () => ({ installed: true, running: true }),
  };
  await installSchedulerServiceGeneration(
    { dataDir: "/scheduler", maxConcurrentRuns: 2 },
    {
      schemaVersion: 1,
      phase: "installing",
      dataDir: "/scheduler",
      maxConcurrentRuns: 2,
      generation: "generation-1",
    },
    {
      createController: (settings) => {
        events.push(`controller:${settings.generation ?? "missing"}`);
        return controller;
      },
      installController: async (received, verifyReady) => {
        assert.equal(received, controller);
        events.push("install");
        await verifyReady();
      },
      waitForGeneration: async (path, generation) => {
        events.push(`ready:${path}:${generation}`);
      },
    },
  );

  assert.deepEqual(events, [
    "controller:generation-1",
    "install",
    "ready:/scheduler/daemon.json:generation-1",
  ]);
});

test("service install 用 daemon lifecycle lock 证明 foreground daemon 已退出", () => {
  let releases = 0;
  assert.doesNotThrow(() =>
    assertSchedulerDaemonStopped("/scheduler", () => ({
      release: () => (releases += 1),
    })),
  );
  assert.equal(releases, 1);
  assert.throws(
    () =>
      assertSchedulerDaemonStopped("/scheduler", () => {
        throw new AgentLifecycleBusyError("scheduler-daemon");
      }),
    /foreground daemon/u,
  );
});

test("service replacement 统计单例占用；force 收尾后只放行显式 inline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-service-blockers-"));
  try {
    const store = new ScheduleStore(dir);
    const createClaim = (name: string, workerId: string) => {
      const schedule = store.createSchedule({
        name,
        prompt: "p",
        cwd: "/workspace",
        trigger: createIntervalTrigger("30m"),
        fireImmediately: false,
      });
      const queued = store.enqueueManualInvocation(schedule.id);
      const claim = store.claimPendingInvocation(queued.id, workerId);
      assert.ok(claim);
      return claim;
    };
    createClaim("inline", "inline-1001");
    createClaim("daemon", "daemon-1002");
    const retryTree = createClaim("retry-tree", "daemon-1003");
    store.beginInvocation(retryTree.invocation.id, retryTree.ownershipToken, Date.now());
    store.recordInvocationTree({
      id: retryTree.invocation.id,
      ownershipToken: retryTree.ownershipToken,
      trackedGroups: [{ pgid: 9001, leaderState: "unknown" }],
      unsettled: true,
    });
    store.failInvocation(retryTree.invocation.id, retryTree.ownershipToken, "retry");
    store.close();

    assert.equal(await countSchedulerServiceBlockers(dir), 3);
    assert.equal(await countSchedulerServiceBlockers(dir, { allowInline: true }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("partial replacement 的显式 uninstall 按 replacementFrom 旧账本收尾", () => {
  const previous = {
    schemaVersion: 1,
    phase: "installed",
    dataDir: "/ledger-a",
    maxConcurrentRuns: 1,
    generation: "generation-a",
  } as const;
  const current = {
    schemaVersion: 1,
    phase: "installing",
    dataDir: "/ledger-b",
    maxConcurrentRuns: 2,
    generation: "generation-b",
    replacementFrom: previous,
  } as const;

  assert.equal(schedulerServiceTeardownState(current), previous);
  assert.equal(schedulerServiceTeardownState(previous), previous);
});

test("Windows partial replacement uninstall 清理旧账本后删除当前 target intent", async () => {
  const home = mkdtempSync(join(tmpdir(), "roll-service-uninstall-intent-"));
  try {
    const statePath = schedulerServiceStatePath(home);
    const previous = {
      schemaVersion: 1,
      phase: "installed",
      dataDir: join(home, "ledger-a"),
      maxConcurrentRuns: 1,
      generation: "generation-a",
    } as const;
    const current = {
      schemaVersion: 1,
      phase: "installing",
      dataDir: join(home, "ledger-b"),
      maxConcurrentRuns: 2,
      generation: "generation-b",
      replacementFrom: previous,
    } as const;
    writeSchedulerServiceState(statePath, current);
    let retired: SchedulerServiceState | undefined;

    await retireWindowsSchedulerServiceIntent(current, statePath, async (state) => {
      retired = state;
      assert.equal(inspectSchedulerServiceState(statePath).status, "valid");
    });

    assert.deepEqual(retired, previous);
    assert.deepEqual(inspectSchedulerServiceState(statePath), { status: "missing" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
