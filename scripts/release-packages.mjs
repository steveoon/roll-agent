#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PUBLISHED_PACKAGES } from "./published-packages.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const publishToken = process.env["NPM_TOKEN"] ?? process.env["NODE_AUTH_TOKEN"];
const dryRun =
  process.argv.includes("--dry-run") || process.env["ROLL_AGENT_RELEASE_DRY_RUN"] === "1";
const PUBLISH_GUARD_HASH = "f48e27617b0e572bfed877cda9a59845eb354fe4e49ba2b00f07d1733e08d574";
const BLOCKED_PUBLISH_LIFECYCLE_SCRIPTS = [
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

async function main() {
  await run("pnpm", ["verify:dependency-denylist"], { env: withoutPublishSecrets(process.env) });
  await run("pnpm", ["build"], { env: withoutPublishSecrets(process.env) });
  await run("pnpm", ["verify:published-packages"], { env: withoutPublishSecrets(process.env) });
  await assertPublishSurface();
  if (dryRun) {
    console.log("Dry run complete; skipping changeset publish.");
    return;
  }
  await publishWithScopedToken();
}

async function publishWithScopedToken() {
  const tempRoot = await mkdtemp(join(tmpdir(), "roll-agent-publish-"));

  try {
    const publishEnv = withoutPublishSecrets(process.env);
    if (publishToken !== undefined && publishToken.length > 0) {
      const npmrcPath = join(tempRoot, ".npmrc");
      await writeFile(npmrcPath, `//registry.npmjs.org/:_authToken=${publishToken}\n`, {
        mode: 0o600,
      });
      publishEnv["NPM_CONFIG_USERCONFIG"] = npmrcPath;
    }

    await run("pnpm", ["exec", "changeset", "publish"], { env: publishEnv });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function assertPublishSurface() {
  const guardPath = resolve(repoRoot, "scripts/require-pnpm-publish.mjs");
  const guardSource = await readFile(guardPath);
  const guardHash = createHash("sha256").update(guardSource).digest("hex");
  assert.equal(
    guardHash,
    PUBLISH_GUARD_HASH,
    "scripts/require-pnpm-publish.mjs changed; review it before publishing with npm credentials",
  );

  for (const pkg of PUBLISHED_PACKAGES) {
    const manifest = JSON.parse(await readFile(resolve(repoRoot, pkg.packageJson), "utf8"));
    assert.equal(manifest.name, pkg.name);
    assertAllowedPublishLifecycle(pkg.name, manifest, pkg.prepublishOnly);
  }
}

function assertAllowedPublishLifecycle(packageName, manifest, expectedPrepublishOnly) {
  const scripts = manifest.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    assert.equal(expectedPrepublishOnly, undefined, `${packageName} is missing scripts`);
    return;
  }

  const blockedScripts = BLOCKED_PUBLISH_LIFECYCLE_SCRIPTS.filter(
    (scriptName) => scriptName in scripts,
  );
  assert.equal(
    blockedScripts.length,
    0,
    `${packageName} has blocked publish-time lifecycle scripts:\n${blockedScripts.join("\n")}`,
  );

  assert.equal(
    scripts.prepublishOnly,
    expectedPrepublishOnly,
    `${packageName} has an unexpected prepublishOnly script`,
  );
}

function withoutPublishSecrets(sourceEnv) {
  const sanitized = { ...sourceEnv };

  for (const key of Object.keys(sanitized)) {
    const normalizedKey = key.toLowerCase();
    if (
      key === "NPM_TOKEN" ||
      key === "NODE_AUTH_TOKEN" ||
      normalizedKey === "github_token" ||
      normalizedKey === "gh_token" ||
      normalizedKey.includes("authtoken") ||
      normalizedKey.includes("auth_token") ||
      normalizedKey.includes("_authtoken")
    ) {
      delete sanitized[key];
    }
  }

  return sanitized;
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}`),
      );
    });
  });
}

main().catch((error) => {
  console.error("release-packages.mjs failed:", error);
  process.exit(1);
});
