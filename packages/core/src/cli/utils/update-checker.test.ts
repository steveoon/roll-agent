import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkForUpdate,
  checkPublishedPackageUpdate,
  fetchLatestPublishedVersion,
  getCurrentVersion,
} from "./update-checker.ts";

function nextPatchVersion(version: string): string {
  const [major = "0", minor = "0", patch = "0"] = version.split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function withFakeHome(run: (fakeHome: string) => Promise<void> | void): Promise<void> | void {
  const oldHome = process.env["HOME"];
  const fakeHome = mkdtempSync(join(tmpdir(), "roll-update-checker-"));

  process.env["HOME"] = fakeHome;

  const restore = () => {
    if (oldHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = oldHome;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  };

  try {
    const result = run(fakeHome);
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

function writeLegacyCache(fakeHome: string, latestVersion: string): void {
  const cacheDir = join(fakeHome, ".roll-agent");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "update-check.json"),
    JSON.stringify({ latestVersion, checkedAt: Date.now() }),
    "utf-8",
  );
}

function writePackageCache(fakeHome: string, packageName: string, latestVersion: string): void {
  const cacheDir = join(fakeHome, ".roll-agent");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "update-check.json"),
    JSON.stringify({
      packages: {
        [packageName]: {
          latestVersion,
          checkedAt: Date.now(),
        },
      },
    }),
    "utf-8",
  );
}

describe("update-checker", () => {
  test("getCurrentVersion returns a valid semver string", () => {
    const version = getCurrentVersion();
    assert.match(version, /^\d+\.\d+\.\d+/);
  });

  test("checkForUpdate reads legacy cached core version when allowNetwork is false", async () => {
    await withFakeHome(async (fakeHome) => {
      const current = getCurrentVersion();
      const latest = nextPatchVersion(current);
      writeLegacyCache(fakeHome, latest);

      const info = await checkForUpdate({ allowNetwork: false });
      assert.equal(info.current, current);
      assert.equal(info.latest, latest);
      assert.equal(info.hasUpdate, true);
    });
  });

  test("fetchLatestPublishedVersion reads cached package version when allowNetwork is false", async () => {
    await withFakeHome(async (fakeHome) => {
      writePackageCache(fakeHome, "@roll-agent/smart-reply-agent", "1.2.3");

      const latest = await fetchLatestPublishedVersion("@roll-agent/smart-reply-agent", {
        allowNetwork: false,
      });
      assert.equal(latest, "1.2.3");
    });
  });

  test("checkPublishedPackageUpdate returns up-to-date when installed version matches cache", async () => {
    await withFakeHome(async (fakeHome) => {
      writePackageCache(fakeHome, "@roll-agent/smart-reply-agent", "1.2.3");

      const info = await checkPublishedPackageUpdate(
        {
          packageName: "@roll-agent/smart-reply-agent",
          packageSpec: "@roll-agent/smart-reply-agent@latest",
          currentVersion: "1.2.3",
        },
        { allowNetwork: false },
      );

      assert.equal(info.status, "up-to-date");
      assert.equal(info.latestVersion, "1.2.3");
    });
  });

  test("checkPublishedPackageUpdate returns update-available for floating specs", async () => {
    await withFakeHome(async (fakeHome) => {
      writePackageCache(fakeHome, "@roll-agent/smart-reply-agent", "1.2.4");

      const info = await checkPublishedPackageUpdate(
        {
          packageName: "@roll-agent/smart-reply-agent",
          packageSpec: "@roll-agent/smart-reply-agent@latest",
          currentVersion: "1.2.3",
        },
        { allowNetwork: false },
      );

      assert.equal(info.status, "update-available");
      assert.equal(info.latestVersion, "1.2.4");
    });
  });

  test("checkPublishedPackageUpdate returns pinned-behind for exact versions", async () => {
    await withFakeHome(async (fakeHome) => {
      writePackageCache(fakeHome, "@roll-agent/smart-reply-agent", "1.2.4");

      const info = await checkPublishedPackageUpdate(
        {
          packageName: "@roll-agent/smart-reply-agent",
          packageSpec: "@roll-agent/smart-reply-agent@1.2.3",
          currentVersion: "1.2.3",
        },
        { allowNetwork: false },
      );

      assert.equal(info.status, "pinned-behind");
      assert.equal(info.latestVersion, "1.2.4");
    });
  });

  test("checkPublishedPackageUpdate returns unsupported-spec for tarball installs", async () => {
    const info = await checkPublishedPackageUpdate(
      {
        packageName: "@roll-agent/smart-reply-agent",
        packageSpec: "file:../../smart-reply-agent-1.2.3.tgz",
        currentVersion: "1.2.3",
      },
      { allowNetwork: false },
    );

    assert.equal(info.status, "unsupported-spec");
    assert.equal(info.latestVersion, undefined);
  });

  test("checkPublishedPackageUpdate returns unknown when current version is missing", async () => {
    const info = await checkPublishedPackageUpdate(
      {
        packageName: "@roll-agent/smart-reply-agent",
        packageSpec: "@roll-agent/smart-reply-agent@latest",
      },
      { allowNetwork: false },
    );

    assert.equal(info.status, "unknown");
  });
});
