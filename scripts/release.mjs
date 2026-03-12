#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const isDryRun = args.has("--dry-run");
const skipChecks = args.has("--skip-checks");
const noRegistryCheck = args.has("--no-registry-check");

const repoRoot = resolve(import.meta.dirname, "..");

const packages = [
  { name: "@roll-agent/sdk", dir: resolve(repoRoot, "packages/sdk") },
  { name: "@roll-agent/core", dir: resolve(repoRoot, "packages/core") },
];

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const details = options.capture
      ? `\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`
      : "";
    throw new Error(`Command failed: ${command} ${commandArgs.join(" ")}${details}`);
  }

  return result;
}

function readVersion(packageDir) {
  const packageJsonPath = resolve(packageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`Invalid version in ${packageJsonPath}`);
  }
  return packageJson.version;
}

function isPublished(packageName, version) {
  const result = spawnSync("npm", ["view", `${packageName}@${version}`, "version", "--json"], {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    return false;
  }

  const output = (result.stdout ?? "").trim();
  return output.length > 0;
}

function runQualityChecks() {
  console.log("\n==> Running quality checks");
  run("pnpm", ["typecheck"]);
  run("pnpm", ["lint"]);
  run("pnpm", ["test"]);
  run("pnpm", ["test:e2e"]);
  run("pnpm", ["build"]);
}

function publishPackage(pkg) {
  const version = readVersion(pkg.dir);
  const registryChecked = !noRegistryCheck;
  const published = registryChecked ? isPublished(pkg.name, version) : false;

  if (published) {
    console.log(`- ${pkg.name}@${version} already published, skipping`);
    return false;
  }

  if (isDryRun) {
    const suffix = registryChecked ? "" : " (registry check skipped)";
    console.log(`- [dry-run] would publish ${pkg.name}@${version}${suffix}`);
    return true;
  }

  const publishArgs = ["publish", "--access", "public"];
  if (process.env["GITHUB_ACTIONS"] === "true") {
    publishArgs.push("--provenance");
  }

  console.log(`- Publishing ${pkg.name}@${version}`);
  run("npm", publishArgs, { cwd: pkg.dir });
  return true;
}

function main() {
  console.log("Roll release script");
  if (isDryRun) {
    console.log("Mode: dry-run");
  }

  if (!skipChecks) {
    runQualityChecks();
  } else {
    console.log("Skipping quality checks (--skip-checks)");
  }

  console.log("\n==> Publishing packages");
  let publishedCount = 0;
  for (const pkg of packages) {
    if (publishPackage(pkg)) {
      publishedCount += 1;
    }
  }

  if (publishedCount === 0) {
    console.log("\nNo new package versions to publish.");
  } else {
    console.log(`\nPublished ${publishedCount} package(s).`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (message.includes("EOTP")) {
    console.error("\nPublish failed because npm requires OTP for this token.");
    console.error("Fix options:");
    console.error("1) Replace NPM_TOKEN with an npm Automation token that has publish access.");
    console.error("2) Switch to npm Trusted Publishing (OIDC) and remove NPM_TOKEN from workflow env.");
  }
  process.exit(1);
}
