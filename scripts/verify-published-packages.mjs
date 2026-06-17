#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const BLOCKED_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
];
const ALLOWED_LIFECYCLE_SCRIPTS = new Map([
  [
    "@roll-agent/browser",
    new Map([["prepublishOnly", "node ../../scripts/require-pnpm-publish.mjs"]]),
  ],
  [
    "@roll-agent/browser-use-agent",
    new Map([["prepublishOnly", "node ../../scripts/require-pnpm-publish.mjs"]]),
  ],
  [
    "@roll-agent/reply-authority-client",
    new Map([["prepublishOnly", "node ../../scripts/require-pnpm-publish.mjs"]]),
  ],
  [
    "@roll-agent/smart-reply-agent",
    new Map([["prepublishOnly", "node ../../scripts/require-pnpm-publish.mjs"]]),
  ],
]);
const SUSPICIOUS_FILE_NAMES = new Set([
  "router_init.js",
  "router_runtime.js",
  "tanstack_runner.js",
  "setup.mjs",
  "gh-token-monitor",
]);
const SUSPICIOUS_TEXT_IOCS = [
  "IfYouRevoke",
  "toJSON(secrets)",
  ".claude/settings",
  ".vscode/tasks",
  "@tanstack/setup",
  "filev2.getsession",
];

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
    expectedJavaScriptFiles: ["package/dist/index.js"],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
    },
  },
  {
    name: "@roll-agent/runtime",
    cwd: resolve(repoRoot, "packages/runtime"),
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
    expectedJavaScriptFiles: ["package/dist/index.js"],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
    },
  },
  {
    name: "@roll-agent/reply-authority-client",
    cwd: resolve(repoRoot, "packages/reply-authority-client"),
    expectedFiles: ["package/dist/index.js", "package/dist/index.d.ts"],
    expectedJavaScriptFiles: ["package/dist/index.js"],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
    },
  },
  {
    name: "@roll-agent/browser-use-agent",
    cwd: resolve(repoRoot, "agents/browser-use"),
    expectedFiles: ["package/dist/index.js", "package/dist/index.d.ts", "package/SKILL.md"],
    expectedJavaScriptFiles: ["package/dist/index.js"],
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
      "package/SKILL.md",
      "package/references/env.yaml",
    ],
    expectedJavaScriptFiles: ["package/dist/index.js"],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
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
      assertNoBlockedLifecycleScripts(pkg.name, manifest);
      assertNoMapFiles(pkg.name, tarEntries);
      assertNoSuspiciousFileNames(pkg.name, tarEntries);
      assertExpectedFiles(pkg.name, tarEntries, pkg.expectedFiles);
      assertExpectedJavaScriptFiles(pkg.name, tarEntries, pkg.expectedJavaScriptFiles);
      await assertNoSourceMapComments(pkg.name, tarballPath, tarEntries);
      await assertNoSuspiciousText(pkg.name, tarballPath, tarEntries);

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

async function readPackedText(tarballPath, entryPath) {
  const { stdout } = await execFileAsync("tar", ["-xOf", tarballPath, entryPath], {
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout;
}

function assertNoBlockedLifecycleScripts(packageName, manifest) {
  const scripts = manifest.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return;
  }

  const allowedScripts = ALLOWED_LIFECYCLE_SCRIPTS.get(packageName) ?? new Map();
  const blockedScripts = BLOCKED_LIFECYCLE_SCRIPTS.filter((scriptName) => scriptName in scripts);
  assert.equal(
    blockedScripts.length,
    0,
    `${packageName} package.json contains blocked lifecycle scripts:\n${blockedScripts.join("\n")}`,
  );

  const prepublishOnly = scripts.prepublishOnly;
  const allowedPrepublishOnly = allowedScripts.get("prepublishOnly");
  if (prepublishOnly !== undefined) {
    assert.equal(
      prepublishOnly,
      allowedPrepublishOnly,
      `${packageName} package.json has an unexpected prepublishOnly script`,
    );
  }
}

function assertNoMapFiles(packageName, tarEntries) {
  const mapFiles = tarEntries.filter(
    (entry) => entry.endsWith(".js.map") || entry.endsWith(".d.ts.map"),
  );
  assert.equal(
    mapFiles.length,
    0,
    `${packageName} tarball still contains source maps:\n${mapFiles.join("\n")}`,
  );
}

function assertNoSuspiciousFileNames(packageName, tarEntries) {
  const suspiciousFiles = tarEntries.filter((entry) => {
    const fileName = entry.split("/").at(-1);
    return fileName !== undefined && SUSPICIOUS_FILE_NAMES.has(fileName);
  });

  assert.equal(
    suspiciousFiles.length,
    0,
    `${packageName} tarball contains suspicious file names:\n${suspiciousFiles.join("\n")}`,
  );
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

function assertExpectedJavaScriptFiles(
  packageName,
  tarEntries,
  expectedJavaScriptFiles = undefined,
) {
  if (!expectedJavaScriptFiles) {
    return;
  }

  const actualJavaScriptFiles = tarEntries.filter((entry) => entry.endsWith(".js")).sort();
  const expectedSorted = [...expectedJavaScriptFiles].sort();

  assert.deepEqual(
    actualJavaScriptFiles,
    expectedSorted,
    `${packageName} tarball has unexpected JavaScript files:\nactual=${actualJavaScriptFiles.join("\n")}\nexpected=${expectedSorted.join("\n")}`,
  );
}

async function assertNoSourceMapComments(packageName, tarballPath, tarEntries) {
  const textEntries = tarEntries.filter(
    (entry) => entry.endsWith(".js") || entry.endsWith(".d.ts"),
  );

  for (const entry of textEntries) {
    const stdout = await readPackedText(tarballPath, entry);
    assert.ok(
      !stdout.includes("sourceMappingURL="),
      `${packageName} packaged file still references a source map: ${entry}`,
    );
  }
}

async function assertNoSuspiciousText(packageName, tarballPath, tarEntries) {
  for (const entry of tarEntries) {
    const text = await readPackedText(tarballPath, entry);
    const matches = SUSPICIOUS_TEXT_IOCS.filter((indicator) => text.includes(indicator));

    assert.equal(
      matches.length,
      0,
      `${packageName} packaged file contains suspicious text indicators in ${entry}:\n${matches.join("\n")}`,
    );
  }
}

main().catch((error) => {
  console.error("verify-published-packages.mjs failed:", error);
  process.exit(1);
});
