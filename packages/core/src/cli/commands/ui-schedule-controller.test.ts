import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ScheduleStore } from "@roll-agent/runtime";
import {
  createDaemonRecord,
  removeDaemonRecord,
  writeDaemonRecord,
} from "../../scheduler-host/daemon-record.ts";
import { createDefaultScheduleController } from "./ui-schedule-controller.ts";

test("UI queries read a legacy-daemon ledger without migration while writes stay fenced", async () => {
  const root = mkdtempSync(join(tmpdir(), "roll-ui-legacy-read-"));
  const oldCwd = process.cwd();
  const oldHome = process.env["HOME"];
  const oldUserProfile = process.env["USERPROFILE"];
  const dataDir = join(root, "ledger");
  const recordPath = join(dataDir, "daemon.json");
  const record = createDaemonRecord("ui-legacy-fixture");
  try {
    process.chdir(root);
    process.env["HOME"] = root;
    process.env["USERPROFILE"] = root;
    writeFileSync(
      join(root, "roll.config.yaml"),
      JSON.stringify({
        scheduler: { "data-dir": dataDir },
        agents: { "data-dir": join(root, "agents") },
      }),
    );
    const emptyController = await createDefaultScheduleController();
    assert.deepEqual(await emptyController.listSchedules(), []);
    assert.deepEqual(await emptyController.listRuns(undefined), []);
    await emptyController.getStatus();
    assert.equal(
      existsSync(dataDir),
      false,
      "UI diagnostic reads must not create a ledger directory",
    );
    const store = new ScheduleStore(dataDir);
    const schedule = store.createSchedule({
      name: "legacy",
      prompt: "noop",
      cwd: root,
      trigger: { kind: "interval", everyMs: 60_000 },
      maxRounds: 2,
    });
    store.close();
    const path = join(dataDir, "schedules.db");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=8");
    db.close();
    const before = readFileSync(path);
    writeDaemonRecord(recordPath, record);
    const controller = await createDefaultScheduleController();
    const rows = await controller.listSchedules();
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
    assert.deepEqual(await controller.listRuns(undefined), []);
    const status = await controller.getStatus();
    assert.ok(typeof status === "object" && status !== null && "daemon" in status);
    assert.ok(
      typeof status.daemon === "object" &&
        status.daemon !== null &&
        "requiresRestart" in status.daemon,
    );
    assert.equal(status.daemon.requiresRestart, true);
    assert.deepEqual(readFileSync(path), before);
    await assert.rejects(async () => controller.pauseSchedule({ id: schedule.id }), /版本不兼容/u);
    assert.deepEqual(readFileSync(path), before);
    removeDaemonRecord(recordPath, record);
    await controller.pauseSchedule({ id: schedule.id });
    const reader = new ScheduleStore(dataDir, { readOnly: true });
    try {
      assert.equal(reader.getSchedule(schedule.id)?.status, "paused");
    } finally {
      reader.close();
    }
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    if (oldUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = oldUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});
