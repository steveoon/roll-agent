import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ScheduleStore, readScheduleLedger } from "@roll-agent/runtime";
import { createScheduleToolBinding } from "./schedule-tool-binding.ts";

function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "roll-extend-binding-")));
  const dataDir = join(cwd, "scheduler");
  const configPath = join(cwd, "roll.config.yaml");
  const config = `scheduler:\n  data-dir: ${dataDir}\n`;
  writeFileSync(configPath, config);
  const store = new ScheduleStore(dataDir);
  const schedule = store.createSchedule(
    {
      name: "巡检",
      prompt: "检查未读消息并回复",
      cwd,
      trigger: { kind: "interval", everyMs: 60_000 },
      maxRounds: 1,
      fireImmediately: true,
    },
    0,
  );
  const claim = store.claimDue({ workerId: "test", nowMs: 1, limit: 1 })[0];
  assert.ok(claim);
  store.beginInvocation(claim.invocation.id, claim.ownershipToken, 2);
  store.completeInvocation({
    id: claim.invocation.id,
    ownershipToken: claim.ownershipToken,
    status: "completed",
    nowMs: 3,
  });
  store.close();
  const binding = createScheduleToolBinding({ serviceStatePath: join(cwd, "service.json") });
  assert.ok(binding.captureExtend && binding.extend);
  return {
    cwd,
    dataDir,
    configPath,
    config,
    schedule,
    binding,
    request: {
      scheduleId: schedule.id,
      rounds: 30,
      expectedMaxRounds: 1,
      requestId: "extension-one",
    },
    close: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test("extension capture is read-only and execution reuses receipt without adding quota twice", async () => {
  const f = fixture();
  try {
    const path = join(f.dataDir, "schedules.db");
    const before = statSync(path).mtimeMs;
    const admission = f.binding.captureExtend?.(f.request, f.cwd);
    assert.ok(admission?.ok);
    assert.equal(statSync(path).mtimeMs, before);
    assert.equal(admission.schedule.prompt, "检查未读消息并回复");
    assert.equal(admission.schedule.roundsStarted, 1);
    const result = await f.binding.extend?.(admission);
    assert.ok(result?.ok);
    assert.equal(result.extended, true);
    assert.deepEqual(result.schedule.rounds, { max: 31, started: 1 });
    assert.equal(result.requestId, f.request.requestId);
    const retryAdmission = f.binding.captureExtend?.(f.request, f.cwd);
    assert.ok(retryAdmission?.ok);
    const replay = await f.binding.extend?.(retryAdmission);
    assert.ok(replay?.ok);
    assert.equal(replay.extended, false);
    assert.deepEqual(replay.schedule.rounds, result.schedule.rounds);
    assert.equal(replay.schedule.nextRunAt, result.schedule.nextRunAt);
  } finally {
    f.close();
  }
});

test("extension rejects authority, ledger and task definition drift after confirmation", async () => {
  for (const change of ["authority", "ledger", "definition"] as const) {
    const f = fixture();
    try {
      const admission = f.binding.captureExtend?.(f.request, f.cwd);
      assert.ok(admission?.ok);
      if (change === "authority") {
        writeFileSync(f.configPath, `${f.config}runtime:\n  approval:\n    default: auto\n`);
      }
      if (change === "ledger") {
        writeFileSync(f.configPath, `scheduler:\n  data-dir: ${join(f.cwd, "other")}\n`);
      }
      if (change === "definition") {
        const db = new DatabaseSync(join(f.dataDir, "schedules.db"));
        db.prepare("UPDATE schedules SET prompt = ? WHERE id = ?").run("另一项任务", f.schedule.id);
        db.close();
      }
      const result = await f.binding.extend?.(admission);
      assert.ok(result && !result.ok, change);
      assert.equal(result.code, "admission_stale");
      assert.equal(readScheduleLedger(f.dataDir).schedules[0]?.maxRounds, 1);
    } finally {
      f.close();
    }
  }
});

test("extension rejects invalid quota and request identifiers before confirmation", () => {
  const f = fixture();
  try {
    for (const request of [
      { ...f.request, rounds: 0 },
      { ...f.request, rounds: 0.5 },
      { ...f.request, rounds: Number.MAX_SAFE_INTEGER },
      { ...f.request, expectedMaxRounds: 0 },
      { ...f.request, requestId: "" },
      { ...f.request, requestId: "x".repeat(129) },
    ]) {
      assert.equal(f.binding.captureExtend?.(request, f.cwd).ok, false);
    }
  } finally {
    f.close();
  }
});
