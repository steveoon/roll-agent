import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ScheduleStore,
  readScheduleLedger,
  readScheduleHistory,
  readScheduleOccupancy,
} from "./schedule-store.ts";
import { DatabaseSync as FixtureDatabaseSync } from "./database-fixture.test.ts";

test("query-only Store uses an empty in-memory view when the ledger is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "roll-empty-reader-"));
  const dir = join(root, "absent");
  try {
    const reader = new ScheduleStore(dir, { readOnly: true });
    try {
      assert.deepEqual(reader.listSchedules(), []);
      assert.equal(reader.nextWakeAtMs(), undefined);
      assert.throws(
        () =>
          reader.createSchedule({
            name: "bad",
            prompt: "noop",
            cwd: "/workspace",
            trigger: { kind: "interval", everyMs: 60_000 },
          }),
        /readonly/u,
      );
    } finally {
      reader.close();
    }
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("query-only Store reads v8 without migration, schema writes, or chmod", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-v8-reader-"));
  try {
    const writer = new ScheduleStore(dir);
    const record = writer.createSchedule(
      {
        name: "legacy",
        prompt: "noop",
        cwd: "/workspace",
        trigger: { kind: "interval", everyMs: 60_000 },
      },
      1_000,
    );
    writer.close();
    const path = join(dir, "schedules.db");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version=8");
    const schema = raw.prepare("PRAGMA schema_version").get()?.schema_version;
    raw.close();
    const before = readFileSync(path);
    const mode = statSync(path).mode;
    const reader = new ScheduleStore(dir, { readOnly: true });
    try {
      assert.equal(reader.getSchedule(record.id)?.name, "legacy");
      assert.equal(reader.nextWakeAtMs(), 61_000);
      assert.deepEqual(reader.listInvocations(record.id), []);
      assert.throws(() => reader.removeSchedule(record.id), /readonly/u);
    } finally {
      reader.close();
    }
    assert.deepEqual(readFileSync(path), before);
    assert.equal(statSync(path).mode, mode);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 8);
    assert.equal(check.prepare("PRAGMA schema_version").get()?.schema_version, schema);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot readers release transactions before close, so a subsequent writer is not blocked", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-reader-unlock-"));
  try {
    const store = new ScheduleStore(dir);
    store.createSchedule({
      name: "before",
      prompt: "noop",
      cwd: "/workspace",
      trigger: { kind: "interval", everyMs: 60_000 },
    });
    store.close();
    for (const read of [readScheduleLedger, readScheduleHistory, readScheduleOccupancy]) {
      read(dir);
      const writer = new FixtureDatabaseSync(join(dir, "schedules.db"));
      try {
        writer.exec("PRAGMA busy_timeout=20");
        assert.doesNotThrow(() => writer.exec("UPDATE schedules SET name='after'"));
      } finally {
        writer.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
