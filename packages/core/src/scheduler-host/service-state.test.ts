import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  inspectSchedulerServiceState,
  installSchedulerServiceWithState,
  removeInvalidSchedulerServiceState,
  requireSchedulerServiceState,
  removeSchedulerServiceState,
  throwSchedulerServiceStateProblem,
  schedulerServiceStatePath,
  SCHEDULER_SERVICE_STATE_PHASES,
  SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
  writeSchedulerServiceState,
} from "./service-state.ts";

test("scheduler service state persists the installed data-dir outside mutable config", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    const state = {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      phase: SCHEDULER_SERVICE_STATE_PHASES.installed,
      dataDir: join(home, "ledger-a"),
      maxConcurrentRuns: 3,
    };
    writeSchedulerServiceState(path, state);
    assert.deepEqual(inspectSchedulerServiceState(path), { status: "valid", state });
    assert.equal(
      removeSchedulerServiceState(path, { ...state, dataDir: join(home, "other") }),
      false,
    );
    assert.equal(removeSchedulerServiceState(path, state), true);
    assert.deepEqual(inspectSchedulerServiceState(path), { status: "missing" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scheduler service state distinguishes malformed metadata from a missing file", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json\n", { encoding: "utf-8", mode: 0o600 });
    const inspection = inspectSchedulerServiceState(path);
    assert.equal(inspection.status, "invalid");
    if (inspection.status === "invalid") {
      assert.match(inspection.error, /invalid JSON/u);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Windows uninstall never falls back to mutable config when installed service state is unavailable", () => {
  assert.throws(() => requireSchedulerServiceState({ status: "missing" }), /metadata is missing/u);
  assert.throws(
    () => requireSchedulerServiceState({ status: "invalid", error: "bad schema" }),
    /bad schema/u,
  );
});

test("partial install keeps the new data-dir metadata instead of a stale previous ledger", async () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    const previous = {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      phase: SCHEDULER_SERVICE_STATE_PHASES.installed,
      dataDir: join(home, "ledger-a"),
      maxConcurrentRuns: 1,
    };
    const next = {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      dataDir: join(home, "ledger-b"),
      maxConcurrentRuns: 2,
    };
    writeSchedulerServiceState(path, previous);

    await assert.rejects(
      installSchedulerServiceWithState(
        path,
        next,
        async () => {
          throw new Error("task start failed");
        },
        { replacementFrom: previous },
      ),
      /task start failed/u,
    );

    const partial = inspectSchedulerServiceState(path);
    assert.equal(partial.status, "valid");
    if (partial.status === "valid") {
      assert.equal(partial.state.phase, SCHEDULER_SERVICE_STATE_PHASES.installing);
      assert.equal(partial.state.dataDir, next.dataDir);
      assert.equal(partial.state.maxConcurrentRuns, next.maxConcurrentRuns);
      assert.equal(typeof partial.state.generation, "string");
      assert.ok((partial.state.generation?.length ?? 0) > 0);
      assert.deepEqual(partial.state.replacementFrom, previous);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scheduler service state on-disk contract is pinned to schemaVersion 1", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    mkdirSync(dirname(path), { recursive: true });
    const dataDir = join(home, "ledger");
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 1, phase: "installed", dataDir, maxConcurrentRuns: 2 })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    assert.deepEqual(inspectSchedulerServiceState(path), {
      status: "valid",
      state: { schemaVersion: 1, phase: "installed", dataDir, maxConcurrentRuns: 2 },
    });
    assert.equal(removeInvalidSchedulerServiceState(path), false);
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 2, phase: "installed", dataDir, maxConcurrentRuns: 2 })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    assert.equal(inspectSchedulerServiceState(path).status, "invalid");
    assert.equal(removeInvalidSchedulerServiceState(path), true);
    assert.deepEqual(inspectSchedulerServiceState(path), { status: "missing" });
    assert.equal(removeInvalidSchedulerServiceState(path), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scheduler service state problems append the caller's recovery hint", () => {
  assert.throws(
    () => throwSchedulerServiceStateProblem({ status: "missing" }, "run schtasks /Delete first"),
    /metadata is missing；run schtasks \/Delete first/u,
  );
  assert.throws(
    () => requireSchedulerServiceState({ status: "invalid", error: "bad schema" }, "hint"),
    /bad schema；hint/u,
  );
});

test("scheduler service state 记录安装时固化的 node、CLI 入口与 roll 版本", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    const state = {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      phase: SCHEDULER_SERVICE_STATE_PHASES.installed,
      dataDir: join(home, "ledger"),
      maxConcurrentRuns: 2,
      binary: {
        command: "/opt/node/bin/node",
        cliEntrypoint: "/opt/roll/dist/cli/index.js",
        rollVersion: "0.9.0",
      },
    };
    writeSchedulerServiceState(path, state);
    assert.deepEqual(inspectSchedulerServiceState(path), { status: "valid", state });
    assert.equal(removeSchedulerServiceState(path, state), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("没有 binary 字段的旧 metadata 仍然有效，binary 读为 undefined", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
        phase: "installed",
        dataDir: join(home, "ledger"),
        maxConcurrentRuns: 2,
      }),
      { encoding: "utf-8", mode: 0o600 },
    );
    const inspection = inspectSchedulerServiceState(path);
    assert.equal(inspection.status, "valid");
    if (inspection.status === "valid") {
      assert.equal(inspection.state.binary, undefined);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("binary 字段残缺的 metadata 视为无效而不是静默丢弃", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
        phase: "installed",
        dataDir: join(home, "ledger"),
        maxConcurrentRuns: 2,
        binary: { command: "/opt/node/bin/node" },
      }),
      { encoding: "utf-8", mode: 0o600 },
    );
    assert.equal(inspectSchedulerServiceState(path).status, "invalid");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("binary command 与 CLI 入口必须是绝对路径", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
        phase: "installed",
        dataDir: join(home, "ledger"),
        maxConcurrentRuns: 2,
        binary: {
          command: "relative-node",
          cliEntrypoint: "relative-roll.js",
          rollVersion: "1.0.0",
        },
      }),
    );
    assert.equal(inspectSchedulerServiceState(path).status, "invalid");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeSchedulerServiceState 把 binary 纳入 CAS，不删除新的 replacement intent", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    const current = {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      phase: SCHEDULER_SERVICE_STATE_PHASES.installing,
      dataDir: join(home, "ledger"),
      maxConcurrentRuns: 2,
      generation: "replacement-new",
      binary: {
        command: "/new/node",
        cliEntrypoint: "/new/roll.js",
        rollVersion: "2.0.0",
      },
    } as const;
    writeSchedulerServiceState(path, current);
    assert.equal(
      removeSchedulerServiceState(path, {
        ...current,
        generation: "replacement-old",
      }),
      false,
    );
    assert.deepEqual(inspectSchedulerServiceState(path), { status: "valid", state: current });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("replacement teardown 不能删除刚写入的同设置 installing intent", async () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    const settings = {
      schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
      dataDir: join(home, "ledger"),
      maxConcurrentRuns: 2,
      binary: {
        command: "/node",
        cliEntrypoint: "/roll.js",
        rollVersion: "2.0.0",
      },
    } as const;
    const previous = {
      ...settings,
      phase: SCHEDULER_SERVICE_STATE_PHASES.installing,
      generation: "previous-generation",
    } as const;
    writeSchedulerServiceState(path, previous);

    await assert.rejects(
      installSchedulerServiceWithState(path, settings, async () => {
        assert.equal(removeSchedulerServiceState(path, previous), false);
        throw new Error("new install failed");
      }),
      /new install failed/u,
    );

    const after = inspectSchedulerServiceState(path);
    assert.equal(after.status, "valid");
    if (after.status === "valid") {
      assert.equal(after.state.phase, SCHEDULER_SERVICE_STATE_PHASES.installing);
      assert.notEqual(after.state.generation, previous.generation);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install callback 使用与 installing metadata 相同的 generation", async () => {
  const home = mkdtempSync(join(tmpdir(), "roll-scheduler-service-state-"));
  try {
    const path = schedulerServiceStatePath(home);
    let observedGeneration: string | undefined;
    const installed = await installSchedulerServiceWithState(
      path,
      {
        schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
        dataDir: join(home, "ledger"),
        maxConcurrentRuns: 2,
      },
      async (installing) => {
        observedGeneration = installing.generation;
        assert.equal(installing.phase, SCHEDULER_SERVICE_STATE_PHASES.installing);
      },
    );

    assert.equal(typeof observedGeneration, "string");
    assert.equal(installed.generation, observedGeneration);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
