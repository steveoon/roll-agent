import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { migrateConfig } from "./config.ts";

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `roll-config-migrate-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("config migrate", () => {
  let cwd: string;
  let previousCwd: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousCwd = process.cwd();
    previousHome = process.env["HOME"];
    cwd = makeTmpDir();
    process.chdir(cwd);
    process.env["HOME"] = cwd;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previousHome;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("validates migrated YAML before creating a backup", () => {
    const configPath = resolve(cwd, "roll.config.yaml");
    const raw = "runtime:\n  bash:\n    enabled: not-a-boolean\n";
    writeFileSync(configPath, raw, "utf-8");

    assert.throws(() => migrateConfig(), /runtime\.shell\.enabled/u);

    assert.equal(readFileSync(configPath, "utf-8"), raw);
    assert.equal(
      readdirSync(cwd).filter((entry) => entry.startsWith("roll.config.yaml.bak.")).length,
      0,
    );
  });

  it("migrates runtime.bash to runtime.shell and backs up the original file", () => {
    const configPath = resolve(cwd, "roll.config.yaml");
    const raw = "runtime:\n  bash:\n    enabled: true\n";
    writeFileSync(configPath, raw, "utf-8");

    migrateConfig();

    const migrated = readFileSync(configPath, "utf-8");
    assert.match(migrated, /shell:/u);
    assert.doesNotMatch(migrated, /bash:/u);
    const backups = readdirSync(cwd).filter((entry) =>
      entry.startsWith("roll.config.yaml.bak."),
    );
    assert.equal(backups.length, 1);
    const backup = backups[0];
    assert.ok(backup !== undefined);
    assert.equal(readFileSync(resolve(cwd, backup), "utf-8"), raw);
  });
});
