#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");

const PACKAGE_CHECKS = [
  {
    name: "@roll-agent/core",
    cwd: resolve(repoRoot, "packages/core"),
    expectedFiles: [
      "package/dist/cli/index.js",
      "package/dist/cli/index.d.ts",
      "package/bin/roll.js",
    ],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/cli/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/cli/index.d.ts");
      assert.equal(manifest.bin?.roll, "./bin/roll.js");
    },
  },
  {
    name: "@roll-agent/sdk",
    cwd: resolve(repoRoot, "packages/sdk"),
    expectedFiles: ["package/dist/index.js", "package/dist/index.d.ts"],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
    },
  },
  {
    name: "@roll-agent/browser",
    cwd: resolve(repoRoot, "packages/browser"),
    expectedFiles: ["package/dist/index.js", "package/dist/index.d.ts"],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
    },
  },
  {
    name: "@roll-agent/browser-use-agent",
    cwd: resolve(repoRoot, "agents/browser-use"),
    expectedFiles: ["package/dist/index.js", "package/dist/index.d.ts", "package/SKILL.md"],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
      assert.equal(manifest.rollAgent?.start?.command, "node");
      assert.deepEqual(manifest.rollAgent?.start?.args, ["dist/index.js"]);
    },
  },
  {
    name: "@roll-agent/smart-reply-agent",
    cwd: resolve(repoRoot, "agents/smart-reply"),
    expectedFiles: [
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/pipeline.js",
      "package/dist/pipeline.d.ts",
      "package/SKILL.md",
      "package/references/reply-policy-schema.md",
    ],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
      assert.equal(manifest.exports?.["./pipeline"].default, "./dist/pipeline.js");
      assert.equal(manifest.exports?.["./pipeline"].types, "./dist/pipeline.d.ts");
      assert.equal(manifest.rollAgent?.start?.command, "node");
      assert.deepEqual(manifest.rollAgent?.start?.args, ["dist/index.js"]);
    },
  },
];

async function main() {
  const packRoot = await mkdtemp(join(tmpdir(), "roll-agent-pack-verify-"));

  try {
    for (const pkg of PACKAGE_CHECKS) {
      console.log(`Verifying ${pkg.name}...`);
      const packagePackDir = await mkdtemp(join(packRoot, "pkg-"));
      const tarballPath = await packPackage(pkg.cwd, packagePackDir);
      const tarEntries = await listTarEntries(tarballPath);
      const manifest = await readPackedJson(tarballPath, "package/package.json");

      pkg.verifyManifest(manifest);
      assertNoMapFiles(pkg.name, tarEntries);
      assertExpectedFiles(pkg.name, tarEntries, pkg.expectedFiles);
      await assertNoSourceMapComments(pkg.name, tarballPath, tarEntries);

      console.log(`  OK: ${pkg.name}`);
    }
  } finally {
    await rm(packRoot, { recursive: true, force: true });
  }
}

async function packPackage(cwd, packRoot) {
  await execFileAsync("pnpm", ["pack", "--pack-destination", packRoot], { cwd });
  const tarballs = (await readdir(packRoot))
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(packRoot, file))
    .sort();

  const tarballPath = tarballs.at(-1);
  assert.ok(tarballPath, `No tarball produced for ${cwd}`);
  return tarballPath;
}

async function listTarEntries(tarballPath) {
  const { stdout } = await execFileAsync("tar", ["-tf", tarballPath]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readPackedJson(tarballPath, entryPath) {
  const { stdout } = await execFileAsync("tar", ["-xOf", tarballPath, entryPath]);
  return JSON.parse(stdout);
}

function assertNoMapFiles(packageName, tarEntries) {
  const mapFiles = tarEntries.filter((entry) => entry.endsWith(".js.map") || entry.endsWith(".d.ts.map"));
  assert.equal(mapFiles.length, 0, `${packageName} tarball still contains source maps:\n${mapFiles.join("\n")}`);
}

function assertExpectedFiles(packageName, tarEntries, expectedFiles) {
  const entrySet = new Set(tarEntries);
  const missingFiles = expectedFiles.filter((file) => !entrySet.has(file));
  assert.equal(
    missingFiles.length,
    0,
    `${packageName} tarball is missing expected files:\n${missingFiles.join("\n")}`,
  );
}

async function assertNoSourceMapComments(packageName, tarballPath, tarEntries) {
  const textEntries = tarEntries.filter((entry) => entry.endsWith(".js") || entry.endsWith(".d.ts"));

  for (const entry of textEntries) {
    const { stdout } = await execFileAsync("tar", ["-xOf", tarballPath, entry], {
      maxBuffer: 1024 * 1024 * 8,
    });
    assert.ok(
      !stdout.includes("sourceMappingURL="),
      `${packageName} packaged file still references a source map: ${entry}`,
    );
  }
}

main().catch((error) => {
  console.error("verify-published-packages.mjs failed:", error);
  process.exit(1);
});
