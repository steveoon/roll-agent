import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScheduleStore, readScheduleLedger } from "./schedule-store.ts";
import { createIntervalTrigger } from "./trigger.ts";
import { scheduleHostContextSchema } from "../host-contracts/schedule-context.ts";

test("opaque host context survives reopening and isolates schedule idempotency", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-host-context-"));
  let store = new ScheduleStore(dir);
  try {
    const input = {
      name: "fixture",
      prompt: "same",
      cwd: dir,
      trigger: createIntervalTrigger("1h"),
    };
    const a = scheduleHostContextSchema.parse("host-a");
    const b = scheduleHostContextSchema.parse("host-b");
    const first = store.createScheduleIdempotent({ ...input, hostContext: a }).schedule;
    assert.equal(store.createScheduleIdempotent({ ...input, hostContext: a }).created, false);
    assert.notEqual(
      store.createScheduleIdempotent({ ...input, hostContext: b }).schedule.id,
      first.id,
    );
    const legacy = store.createScheduleIdempotent(input).schedule;
    assert.notEqual(legacy.id, first.id);
    assert.equal(legacy.hostContext, undefined);
    store.close();
    store = new ScheduleStore(dir);
    assert.equal(store.getSchedule(first.id)?.hostContext, a);
    assert.equal(store.listSchedules().length, 3);
    assert.throws(() => scheduleHostContextSchema.parse(""));
    assert.throws(() => scheduleHostContextSchema.parse("x".repeat(8193)));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("schema 9 migration keeps legacy rows and rejects corrupt durable context", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-host-migration-"));
  let store = new ScheduleStore(dir);
  try {
    const record = store.createSchedule({
      name: "old",
      prompt: "old",
      cwd: dir,
      trigger: createIntervalTrigger("1h"),
    });
    store.close();
    const db = new DatabaseSync(join(dir, "schedules.db"));
    for (const r of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all()) {
      db.exec(`DROP TRIGGER ${String(r.name)}`);
    }
    db.exec("ALTER TABLE schedules DROP COLUMN host_context; PRAGMA user_version=9;");
    db.close();
    const before = readFileSync(join(dir, "schedules.db"));
    const inspected = readScheduleLedger(dir);
    assert.equal(inspected.status, "ok");
    assert.deepEqual(readFileSync(join(dir, "schedules.db")), before);
    store = new ScheduleStore(dir);
    assert.equal(store.getSchedule(record.id)?.hostContext, undefined);
    const corrupt = new DatabaseSync(join(dir, "schedules.db"));
    corrupt.exec("ATTACH DATABASE ':memory:' AS roll_scheduler_writer_v10");
    corrupt.prepare("UPDATE schedules SET host_context='' WHERE id=?").run(record.id);
    corrupt.close();
    assert.throws(() => store.getSchedule(record.id), /context|上下文/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrading fences an already-open v9 writer without losing the bound row", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-old-host-writer-"));
  let store = new ScheduleStore(dir);
  const old = new DatabaseSync(join(dir, "schedules.db"));
  try {
    const record = store.createSchedule({
      name: "old",
      prompt: "old",
      cwd: dir,
      trigger: createIntervalTrigger("1h"),
    });
    store.close();
    for (const row of old.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all()) {
      old.exec(`DROP TRIGGER ${String(row.name)}`);
    }
    old.exec(
      "ALTER TABLE schedules DROP COLUMN host_context; PRAGMA user_version=9; ATTACH DATABASE ':memory:' AS roll_scheduler_writer_v9",
    );
    store = new ScheduleStore(dir);
    assert.throws(
      () => old.prepare("UPDATE schedules SET name='stale' WHERE id=?").run(record.id),
      /writer version mismatch/,
    );
    assert.equal(store.getSchedule(record.id)?.name, "old");
  } finally {
    old.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
