import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEDULER_SERVICE_INSTALL_ACTIONS,
  SCHEDULER_SERVICE_RESTART_ACTIONS,
  SCHEDULER_SERVICE_UNINSTALL_ACTIONS,
  planSchedulerServiceInstall,
  planSchedulerServiceRestart,
  planSchedulerServiceUninstall,
} from "./service-plan.ts";
import {
  SCHEDULER_SERVICE_STATE_PHASES,
  SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
  type SchedulerServiceStateInspection,
} from "./service-state.ts";

const next = { dataDir: "/data/next", maxConcurrentRuns: 2 } as const;

function valid(
  overrides: Partial<{
    phase: "installing" | "installed";
    dataDir: string;
    maxConcurrentRuns: number;
  }> = {},
): SchedulerServiceStateInspection {
  return {
    status: "valid",
    state: {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      phase: SCHEDULER_SERVICE_STATE_PHASES.installed,
      dataDir: next.dataDir,
      maxConcurrentRuns: next.maxConcurrentRuns,
      ...overrides,
    },
  };
}

const running = { installed: true, running: true, enabled: true } as const;
const disabled = { installed: true, running: false, enabled: false } as const;
const absent = { installed: false, running: false } as const;

test("install plan: unchanged installed settings only refresh the definition", () => {
  for (const platform of ["win32", "darwin"] as const) {
    for (const status of [running, absent]) {
      assert.equal(
        planSchedulerServiceInstall({ platform, inspection: valid(), next, status }),
        SCHEDULER_SERVICE_INSTALL_ACTIONS.refresh,
        `${platform} ${String(status.installed)}`,
      );
    }
  }
});

test("install plan: Windows finishes an interrupted teardown before re-arming a disabled task", () => {
  assert.equal(
    planSchedulerServiceInstall({ platform: "win32", inspection: valid(), next, status: disabled }),
    SCHEDULER_SERVICE_INSTALL_ACTIONS.retire,
  );
  assert.equal(
    planSchedulerServiceInstall({
      platform: "darwin",
      inspection: valid(),
      next,
      status: disabled,
    }),
    SCHEDULER_SERVICE_INSTALL_ACTIONS.refresh,
  );
});

test("install plan: installing phase or changed settings retire (win32) / replace (POSIX) first", () => {
  const cases = [
    valid({ phase: SCHEDULER_SERVICE_STATE_PHASES.installing }),
    valid({ dataDir: "/data/previous" }),
    valid({ maxConcurrentRuns: 1 }),
  ];
  for (const inspection of cases) {
    assert.equal(
      planSchedulerServiceInstall({ platform: "win32", inspection, next, status: running }),
      SCHEDULER_SERVICE_INSTALL_ACTIONS.retire,
    );
    assert.equal(
      planSchedulerServiceInstall({ platform: "linux", inspection, next, status: running }),
      SCHEDULER_SERVICE_INSTALL_ACTIONS.replace,
    );
  }
});

test("install plan: without usable metadata Windows fails closed only when a task exists", () => {
  for (const inspection of [
    { status: "missing" },
    { status: "invalid", error: "bad" },
  ] as const satisfies readonly SchedulerServiceStateInspection[]) {
    assert.equal(
      planSchedulerServiceInstall({ platform: "win32", inspection, next, status: running }),
      SCHEDULER_SERVICE_INSTALL_ACTIONS.failClosed,
    );
    assert.equal(
      planSchedulerServiceInstall({ platform: "win32", inspection, next, status: absent }),
      SCHEDULER_SERVICE_INSTALL_ACTIONS.install,
    );
    assert.equal(
      planSchedulerServiceInstall({ platform: "darwin", inspection, next, status: running }),
      SCHEDULER_SERVICE_INSTALL_ACTIONS.failClosed,
    );
    assert.equal(
      planSchedulerServiceInstall({ platform: "darwin", inspection, next, status: absent }),
      SCHEDULER_SERVICE_INSTALL_ACTIONS.install,
    );
  }
});

test("uninstall plan: metadata drives the teardown, POSIX never needs it, only Windows fails closed", () => {
  assert.equal(
    planSchedulerServiceUninstall({ platform: "win32", inspection: valid(), taskInstalled: false }),
    SCHEDULER_SERVICE_UNINSTALL_ACTIONS.retire,
  );
  assert.equal(
    planSchedulerServiceUninstall({
      platform: "darwin",
      inspection: valid(),
      taskInstalled: false,
    }),
    SCHEDULER_SERVICE_UNINSTALL_ACTIONS.uninstallByMetadata,
  );
  for (const inspection of [
    { status: "missing" },
    { status: "invalid", error: "bad" },
  ] as const satisfies readonly SchedulerServiceStateInspection[]) {
    assert.equal(
      planSchedulerServiceUninstall({ platform: "darwin", inspection, taskInstalled: true }),
      SCHEDULER_SERVICE_UNINSTALL_ACTIONS.uninstallByDefaults,
    );
    assert.equal(
      planSchedulerServiceUninstall({ platform: "darwin", inspection, taskInstalled: false }),
      SCHEDULER_SERVICE_UNINSTALL_ACTIONS.nothingInstalled,
    );
    assert.equal(
      planSchedulerServiceUninstall({ platform: "win32", inspection, taskInstalled: true }),
      SCHEDULER_SERVICE_UNINSTALL_ACTIONS.failClosed,
    );
    assert.equal(
      planSchedulerServiceUninstall({ platform: "win32", inspection, taskInstalled: false }),
      SCHEDULER_SERVICE_UNINSTALL_ACTIONS.nothingInstalled,
    );
  }
});

test("install：设置未变但固化的二进制已过期时，POSIX 走 replace、Windows 走 retire 以重启 daemon", () => {
  const status = { installed: true, running: true };
  assert.equal(
    planSchedulerServiceInstall({
      platform: "darwin",
      inspection: valid(),
      next,
      status,
      binaryStale: false,
    }),
    SCHEDULER_SERVICE_INSTALL_ACTIONS.refresh,
  );
  assert.equal(
    planSchedulerServiceInstall({
      platform: "darwin",
      inspection: valid(),
      next,
      status,
      binaryStale: true,
    }),
    SCHEDULER_SERVICE_INSTALL_ACTIONS.replace,
  );
  assert.equal(
    planSchedulerServiceInstall({
      platform: "win32",
      inspection: valid(),
      next,
      status,
      binaryStale: true,
    }),
    SCHEDULER_SERVICE_INSTALL_ACTIONS.retire,
  );
});

test("install：需要替换服务且仍有 live invocation 时拒绝，不得绕过 restart 门禁", () => {
  for (const platform of ["darwin", "win32"] as const) {
    assert.equal(
      planSchedulerServiceInstall({
        platform,
        inspection: valid(),
        next,
        status: running,
        binaryStale: true,
        liveInvocations: 1,
      }),
      SCHEDULER_SERVICE_INSTALL_ACTIONS.refuseLiveRuns,
    );
  }
});

test("install：disabled cleanup / installing recovery 即使账本有 live 也继续收尾", () => {
  assert.equal(
    planSchedulerServiceInstall({
      platform: "win32",
      inspection: valid(),
      next,
      status: disabled,
      liveInvocations: 1,
    }),
    SCHEDULER_SERVICE_INSTALL_ACTIONS.retire,
  );
  assert.equal(
    planSchedulerServiceInstall({
      platform: "darwin",
      inspection: valid({ phase: "installing" }),
      next,
      status: running,
      liveInvocations: 1,
    }),
    SCHEDULER_SERVICE_INSTALL_ACTIONS.replace,
  );
});

test("restart：未安装或 metadata 无效时拒绝，有 live invocation 时除非 --force 否则拒绝", () => {
  assert.equal(
    planSchedulerServiceRestart({
      inspection: { status: "missing" },
      liveInvocations: 0,
      force: false,
    }),
    SCHEDULER_SERVICE_RESTART_ACTIONS.notInstalled,
  );
  assert.equal(
    planSchedulerServiceRestart({
      inspection: { status: "invalid", error: "bad" },
      liveInvocations: 0,
      force: false,
    }),
    SCHEDULER_SERVICE_RESTART_ACTIONS.notInstalled,
  );
  assert.equal(
    planSchedulerServiceRestart({
      inspection: valid({ phase: "installing" }),
      liveInvocations: 0,
      force: false,
    }),
    SCHEDULER_SERVICE_RESTART_ACTIONS.restart,
  );
  assert.equal(
    planSchedulerServiceRestart({ inspection: valid(), liveInvocations: 2, force: false }),
    SCHEDULER_SERVICE_RESTART_ACTIONS.refuseLiveRuns,
  );
  assert.equal(
    planSchedulerServiceRestart({ inspection: valid(), liveInvocations: 2, force: true }),
    SCHEDULER_SERVICE_RESTART_ACTIONS.restart,
  );
  assert.equal(
    planSchedulerServiceRestart({ inspection: valid(), liveInvocations: 0, force: false }),
    SCHEDULER_SERVICE_RESTART_ACTIONS.restart,
  );
});
