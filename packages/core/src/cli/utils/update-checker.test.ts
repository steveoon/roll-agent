import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkForUpdate, getCurrentVersion } from "./update-checker.ts";

function nextPatchVersion(version: string): string {
  const [major = "0", minor = "0", patch = "0"] = version.split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

describe("update-checker", () => {
  test("getCurrentVersion returns a valid semver string", () => {
    const version = getCurrentVersion();
    assert.match(version, /^\d+\.\d+\.\d+/);
  });

  test("checkForUpdate reads cached version when allowNetwork is false", async () => {
    const oldHome = process.env["HOME"];
    const fakeHome = mkdtempSync(join(tmpdir(), "roll-update-checker-"));
    const cacheDir = join(fakeHome, ".roll-agent");
    const current = getCurrentVersion();
    const latest = nextPatchVersion(current);

    process.env["HOME"] = fakeHome;
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "update-check.json"),
      JSON.stringify({ latestVersion: latest, checkedAt: Date.now() }),
      "utf-8",
    );

    try {
      const info = await checkForUpdate({ allowNetwork: false });
      assert.equal(info.current, current);
      assert.equal(info.latest, latest);
      assert.equal(info.hasUpdate, true);
    } finally {
      if (oldHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = oldHome;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
