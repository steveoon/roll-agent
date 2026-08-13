#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PUBLISHED_PACKAGES } from "./published-packages.mjs";

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
export const SUSPICIOUS_FILE_NAMES = new Set([
  "router_init.js",
  "router_runtime.js",
  "tanstack_runner.js",
  "setup.mjs",
  "Math_Symbol.js",
  "math_init.js",
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
const RELAY_PROTOCOL_FORBIDDEN_IMPORTS = [
  "node:",
  "@roll-agent/client-node",
  "@roll-agent/runtime",
  "@roll-agent/companion",
];
const RELAY_CLIENT_FORBIDDEN_IMPORTS = [
  "node:",
  "@roll-agent/client-node",
  "@roll-agent/runtime",
  "@roll-agent/companion",
  "@roll-agent/core",
  "react",
];

const PACKAGE_CHECKS = [
  {
    name: "@roll-agent/core",
    cwd: resolve(repoRoot, "packages/core"),
    expectedFiles: [
      "package/dist/cli/index.js",
      "package/dist/cli/index.d.ts",
      "package/dist/ui-assets/index.html",
      "package/dist/ui-assets/assets/app.js",
      "package/dist/ui-assets/assets/app.css",
      "package/bin/roll.js",
      "package/THIRD_PARTY_NOTICES.txt",
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
    name: "@roll-agent/protocol",
    cwd: resolve(repoRoot, "packages/protocol"),
    expectedFiles: [
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/schema/roll-runtime-protocol-v1.schema.json",
      "package/fixtures/v1/valid-initialize-request.json",
      "package/fixtures/v1/valid-thread-snapshot-response.json",
      "package/fixtures/v1/valid-runtime-event-notification.json",
      "package/fixtures/v1/invalid-turn-start-request.json",
      "package/fixtures/v1/invalid-operation-raw-response.json",
    ],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
      assert.equal(
        manifest.exports?.["./schema"],
        "./dist/schema/roll-runtime-protocol-v1.schema.json",
      );
    },
  },
  {
    name: "@roll-agent/relay-protocol",
    cwd: resolve(repoRoot, "packages/relay-protocol"),
    expectedFiles: [
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/conformance.js",
      "package/dist/conformance.d.ts",
      "package/dist/control.js",
      "package/dist/control.d.ts",
      "package/dist/reference-adapter.js",
      "package/dist/reference-adapter.d.ts",
      "package/dist/schema/roll-relay-protocol-v1.schema.json",
      "package/dist/schema/roll-relay-protocol-v1.1.schema.json",
      "package/dist/schema/roll-relay-control-v1.schema.json",
      "package/dist/schema/roll-relay-browser-session-v1.schema.json",
      "package/fixtures/control/v1.0/manifest.json",
      "package/fixtures/control/v1.0/valid-session-ready.json",
      "package/fixtures/control/v1.0/invalid-session-ready-wire-version.json",
      "package/fixtures/v1.1/manifest.json",
      "package/fixtures/v1.1/valid-interaction-request-approval.json",
      "package/fixtures/v1.1/valid-interaction-candidate-user-input.json",
    ],
    expectedJavaScriptFiles: [
      "package/dist/conformance.js",
      "package/dist/control.js",
      "package/dist/index.js",
      "package/dist/reference-adapter.js",
    ],
    expectedFixturePrefix: "package/fixtures/v1/",
    expectedFixtureManifest: "package/fixtures/control/v1.0/manifest.json",
    forbiddenPackagedText: RELAY_PROTOCOL_FORBIDDEN_IMPORTS,
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
      assert.equal(manifest.exports?.["./conformance"].default, "./dist/conformance.js");
      assert.equal(manifest.exports?.["./conformance"].types, "./dist/conformance.d.ts");
      assert.equal(manifest.exports?.["./control"].default, "./dist/control.js");
      assert.equal(manifest.exports?.["./control"].types, "./dist/control.d.ts");
      assert.equal(
        manifest.exports?.["./control/schema"],
        "./dist/schema/roll-relay-control-v1.schema.json",
      );
      assert.equal(
        manifest.exports?.["./control/session-schema"],
        "./dist/schema/roll-relay-browser-session-v1.schema.json",
      );
      assert.equal(manifest.exports?.["./control/fixtures/*"], "./fixtures/control/v1.0/*");
      assert.equal(
        manifest.exports?.["./reference-adapter"].default,
        "./dist/reference-adapter.js",
      );
      assert.equal(
        manifest.exports?.["./reference-adapter"].types,
        "./dist/reference-adapter.d.ts",
      );
      assert.equal(
        manifest.exports?.["./schema"],
        "./dist/schema/roll-relay-protocol-v1.schema.json",
      );
      assert.equal(
        manifest.exports?.["./schema/v1.0"],
        "./dist/schema/roll-relay-protocol-v1.schema.json",
      );
      assert.equal(
        manifest.exports?.["./schema/v1.1"],
        "./dist/schema/roll-relay-protocol-v1.1.schema.json",
      );
      assert.equal(manifest.exports?.["./fixtures/*"], "./fixtures/*");
    },
  },
  {
    name: "@roll-agent/relay-client",
    cwd: resolve(repoRoot, "packages/relay-client"),
    expectedFiles: [
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/testing.js",
      "package/dist/testing.d.ts",
    ],
    expectedJavaScriptFiles: [
      "package/dist/client.js",
      "package/dist/index.js",
      "package/dist/schemas.js",
      "package/dist/testing.js",
      "package/dist/transport.js",
    ],
    forbiddenPackagedText: RELAY_CLIENT_FORBIDDEN_IMPORTS,
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
      assert.equal(manifest.exports?.["./testing"].default, "./dist/testing.js");
      assert.equal(manifest.exports?.["./testing"].types, "./dist/testing.d.ts");
    },
  },
  {
    name: "@roll-agent/client-node",
    cwd: resolve(repoRoot, "packages/client-node"),
    expectedFiles: ["package/dist/index.js", "package/dist/index.d.ts"],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
    },
  },
  {
    name: "@roll-agent/companion",
    cwd: resolve(repoRoot, "packages/companion"),
    expectedFiles: [
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/testing.js",
      "package/dist/testing.d.ts",
    ],
    expectedJavaScriptFiles: [
      "package/dist/companion-workspace.js",
      "package/dist/event-buffer.js",
      "package/dist/index.js",
      "package/dist/interaction-broker.js",
      "package/dist/lease-manager.js",
      "package/dist/relay-bridge-v11.js",
      "package/dist/relay-bridge.js",
      "package/dist/relay-frame-buffer.js",
      "package/dist/relay-protocol.js",
      "package/dist/testing.js",
    ],
    verifyManifest(manifest) {
      assert.equal(manifest.exports?.["."].default, "./dist/index.js");
      assert.equal(manifest.exports?.["."].types, "./dist/index.d.ts");
      assert.equal(manifest.exports?.["./testing"].default, "./dist/testing.js");
      assert.equal(manifest.exports?.["./testing"].types, "./dist/testing.d.ts");
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
  assertPublishedPackageChecksMatch();
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
      assertExpectedFixtureSet(pkg.name, tarEntries, pkg.expectedFixturePrefix);
      await assertExpectedFixtureManifest(
        pkg.name,
        tarballPath,
        tarEntries,
        pkg.expectedFixtureManifest,
      );
      await assertNoSourceMapComments(pkg.name, tarballPath, tarEntries);
      await assertNoForbiddenPackagedText(
        pkg.name,
        tarballPath,
        tarEntries,
        pkg.forbiddenPackagedText,
      );
      await assertNoSuspiciousText(pkg.name, tarballPath, tarEntries);

      console.log(`  OK: ${pkg.name}`);
    }
  } finally {
    await rm(packRoot, { recursive: true, force: true });
  }
}

function assertPublishedPackageChecksMatch() {
  const publishedPackageNames = PUBLISHED_PACKAGES.map(({ name }) => name).sort();
  const checkedPackageNames = PACKAGE_CHECKS.map(({ name }) => name).sort();

  assert.deepEqual(
    checkedPackageNames,
    publishedPackageNames,
    "Published package registry and tarball checks must contain the same package names",
  );
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

function assertExpectedFixtureSet(packageName, tarEntries, expectedFixturePrefix = undefined) {
  if (!expectedFixturePrefix) {
    return;
  }

  const fixtureFiles = tarEntries.filter(
    (entry) => entry.startsWith(expectedFixturePrefix) && entry.endsWith(".json"),
  );
  const fixtureNames = fixtureFiles.map((entry) => entry.slice(expectedFixturePrefix.length));

  assert.ok(
    fixtureNames.some((name) => name.startsWith("valid-")),
    `${packageName} tarball has no valid JSON fixture under ${expectedFixturePrefix}`,
  );
  assert.ok(
    fixtureNames.some((name) => name.startsWith("invalid-")),
    `${packageName} tarball has no invalid JSON fixture under ${expectedFixturePrefix}`,
  );
}

async function assertExpectedFixtureManifest(
  packageName,
  tarballPath,
  tarEntries,
  expectedFixtureManifest = undefined,
) {
  if (!expectedFixtureManifest) {
    return;
  }

  const manifest = await readPackedJson(tarballPath, expectedFixtureManifest);
  const collections = [manifest.messages, manifest.sessions];
  const fixtureNames = collections.flatMap((entries) => {
    assert.ok(Array.isArray(entries), `${expectedFixtureManifest} must contain fixture arrays`);
    return entries.map((entry) => {
      assert.equal(
        typeof entry.fixture,
        "string",
        `${expectedFixtureManifest} has invalid entries`,
      );
      return entry.fixture;
    });
  });
  const fixturePrefix = expectedFixtureManifest.slice(
    0,
    expectedFixtureManifest.lastIndexOf("/") + 1,
  );
  const entrySet = new Set(tarEntries);
  const missingFixtures = fixtureNames
    .map((fixture) => `${fixturePrefix}${fixture}`)
    .filter((fixture) => !entrySet.has(fixture));
  assert.equal(
    missingFixtures.length,
    0,
    `${packageName} tarball is missing fixtures declared by ${expectedFixtureManifest}:\n${missingFixtures.join("\n")}`,
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

async function assertNoForbiddenPackagedText(
  packageName,
  tarballPath,
  tarEntries,
  forbiddenText = undefined,
) {
  if (!forbiddenText) {
    return;
  }

  const sourceEntries = tarEntries.filter(
    (entry) => entry.endsWith(".js") || entry.endsWith(".d.ts"),
  );

  for (const entry of sourceEntries) {
    const source = await readPackedText(tarballPath, entry);
    const matches = forbiddenText.filter((indicator) => source.includes(indicator));

    assert.equal(
      matches.length,
      0,
      `${packageName} packaged source contains forbidden imports in ${entry}:\n${matches.join("\n")}`,
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

const entryPointUrl =
  process.argv[1] !== undefined ? pathToFileURL(process.argv[1]).href : undefined;

if (import.meta.url === entryPointUrl) {
  main().catch((error) => {
    console.error("verify-published-packages.mjs failed:", error);
    process.exit(1);
  });
}
