import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  findBlockedLockfileCoordinates,
  isBlockedCoordinate,
  isBlockedDirectDependency,
} from "./verify-dependency-denylist.mjs";

const SHAI_HULUD_KEYV_FAMILY = [
  ["keyv", "6.0.0"],
  ["flat-cache", "6.1.24"],
  ["file-entry-cache", "11.1.6"],
  ["cacheable-request", "13.0.20"],
  ["cacheable", "2.5.1"],
  ["@cacheable/memory", "2.2.1"],
  ["cache-manager", "7.2.10"],
  ["@cacheable/node-cache", "3.1.2"],
  ["@cacheable/utils", "2.5.1"],
  ["@cacheable/net", "2.1.1"],
  ["ecto", "5.0.1"],
];

describe("dependency denylist", () => {
  it("blocks the Shai-Hulud keyv-family coordinates and leaves the locked safe versions alone", () => {
    for (const [packageName, version] of SHAI_HULUD_KEYV_FAMILY) {
      assert.equal(
        isBlockedCoordinate(packageName, version),
        true,
        `${packageName}@${version} must be denylisted`,
      );
    }

    assert.equal(isBlockedCoordinate("keyv", "4.5.4"), false);
    assert.equal(isBlockedCoordinate("flat-cache", "4.0.1"), false);
    assert.equal(isBlockedCoordinate("file-entry-cache", "8.0.0"), false);
    assert.equal(isBlockedCoordinate("node-ipc", "9.1.6"), true);
    assert.equal(isBlockedDirectDependency("keyv", "4.5.4"), false);
    assert.equal(isBlockedDirectDependency("keyv", "6.0.0"), true);
    assert.equal(isBlockedDirectDependency("node-ipc", "^9.0.0"), true);
  });

  it("keeps strictDepBuilds enabled so unreviewed lifecycle scripts fail install", async () => {
    const yaml = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
    assert.match(yaml, /^strictDepBuilds:\s*true\s*$/m);
  });

  it("detects quoted scoped pnpm lockfile keys, including peer-suffix snapshots", () => {
    const lockfile = [
      "packages:",
      "  '@cacheable/memory@2.2.1':",
      "    resolution: {integrity: sha512-fake}",
      "  '@cacheable/node-cache@3.1.2(@types/node@22.19.15)':",
      "  \"@cacheable/net@2.1.1\":",
      "  keyv@6.0.0:",
      "    dependencies:",
      "      '@cacheable/utils': 2.5.1",
      "      '@cacheable/memory': 2.2.1(@types/node@22.19.15)",
      "  keyv@4.5.4:",
      "    dependencies:",
      "      json-buffer: 3.0.1",
    ].join("\n");

    const coords = findBlockedLockfileCoordinates(lockfile)
      .map((finding) => `${finding.packageName}@${finding.version}`)
      .sort();

    assert.deepEqual(coords, [
      "@cacheable/memory@2.2.1",
      "@cacheable/memory@2.2.1",
      "@cacheable/net@2.1.1",
      "@cacheable/node-cache@3.1.2",
      "@cacheable/utils@2.5.1",
      "keyv@6.0.0",
    ]);
  });

  it("detects blocked coordinates behind multi and nested peer suffixes", () => {
    const lockfile = [
      "packages:",
      "  keyv@6.0.0(peer-a@1.0.0)(peer-b@2.0.0):",
      "  '@cacheable/memory@2.2.1(eslint@9.39.4(jiti@2.7.0))(typescript@5.9.3)':",
      "  foo@1.0.0:",
      "    dependencies:",
      "      '@cacheable/utils': 2.5.1(peer-a@1.0.0(peer-c@3.0.0))",
      "      keyv: 6.0.0(peer-a@1.0.0)(peer-b@2.0.0)",
      "      vite: 6.4.3(@types/node@22.19.15)(jiti@2.7.0)(lightningcss@1.32.0)",
    ].join("\n");

    const coords = findBlockedLockfileCoordinates(lockfile)
      .map((finding) => `${finding.packageName}@${finding.version}`)
      .sort();

    assert.deepEqual(coords, [
      "@cacheable/memory@2.2.1",
      "@cacheable/utils@2.5.1",
      "keyv@6.0.0",
      "keyv@6.0.0",
    ]);
  });
});
