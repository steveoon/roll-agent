import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "./database-fixture.test.ts";
import { ScheduleStore } from "./schedule-store.ts";

test("reopening a scheduler keeps schema_version stable and repairs only changed guards", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-guard-ddl-"));
  const first = new ScheduleStore(dir);
  first.close();
  const raw = new DatabaseSync(join(dir, "schedules.db"));
  try {
    const version = () => raw.prepare("PRAGMA schema_version").get()?.schema_version;
    const before = version();
    const second = new ScheduleStore(dir);
    second.close();
    assert.equal(version(), before);
    raw.exec("DROP TRIGGER scheduler_writer_schedules_update");
    const missing = Number(version());
    const repaired = new ScheduleStore(dir);
    repaired.close();
    assert.equal(version(), missing + 1);
    raw.exec(
      "DROP TRIGGER scheduler_writer_schedules_update; CREATE TRIGGER scheduler_writer_schedules_update BEFORE UPDATE ON schedules BEGIN SELECT 1; END;",
    );
    const stale = Number(version());
    const updated = new ScheduleStore(dir);
    updated.close();
    assert.equal(version(), stale + 2);
    const stable = version();
    new ScheduleStore(dir).close();
    assert.equal(version(), stable);
  } finally {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
