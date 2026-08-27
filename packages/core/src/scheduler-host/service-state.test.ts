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
      installSchedulerServiceWithState(path, next, async () => {
        throw new Error("task start failed");
      }),
      /task start failed/u,
    );

    assert.deepEqual(inspectSchedulerServiceState(path), {
      status: "valid",
      state: { ...next, phase: SCHEDULER_SERVICE_STATE_PHASES.installing },
    });
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
