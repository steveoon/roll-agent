import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openReadOnlySchedulerDatabase } from "./read-only-sqlite.ts";

test("scheduler readonly connection rejects writes and never creates a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-native-readonly-"));
  try {
    const path = join(dir, "fixture.db");
    const writer = new DatabaseSync(path);
    writer.exec("CREATE TABLE probe(value)");
    writer.close();
    const reader = openReadOnlySchedulerDatabase(path);
    try {
      assert.equal(reader.prepare("PRAGMA query_only").get()?.query_only, 1);
      assert.throws(() => reader.exec("INSERT INTO probe VALUES(1)"), /readonly/u);
      assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM probe").get()?.n, 0);
    } finally {
      reader.close();
    }
    const missing = join(dir, "absent.db");
    assert.throws(() => openReadOnlySchedulerDatabase(missing));
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
