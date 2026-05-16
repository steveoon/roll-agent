#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const BLOCKED_DEPENDENCIES = new Map([
  ["node-ipc", new Set(["9.1.6", "9.2.3", "12.0.1"])],
]);

async function main() {
  const findings = [];

  for (const packageJsonPath of await findPackageJsonFiles(repoRoot)) {
    findings.push(...(await findBlockedManifestDependencies(packageJsonPath)));
  }

  findings.push(...(await findBlockedLockfileDependencies(resolve(repoRoot, "pnpm-lock.yaml"))));

  assert.equal(
    findings.length,
    0,
    `Blocked dependency coordinates were found:\n${findings.map(formatFinding).join("\n")}`,
  );

  console.log("Dependency denylist OK");
}

async function findPackageJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...(await findPackageJsonFiles(path)));
      }
      continue;
    }

    if (entry.isFile() && entry.name === "package.json") {
      files.push(path);
    }
  }

  return files;
}

async function findBlockedManifestDependencies(packageJsonPath) {
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const findings = [];

  if (typeof manifest.name === "string") {
    const blockedVersions = BLOCKED_DEPENDENCIES.get(manifest.name);
    if (blockedVersions?.has(String(manifest.version))) {
      findings.push({
        source: formatPath(packageJsonPath),
        packageName: manifest.name,
        version: String(manifest.version),
        reason: "workspace package matches a blocked package coordinate",
      });
    }
  }

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
      continue;
    }

    for (const [packageName, versionSpec] of Object.entries(dependencies)) {
      if (BLOCKED_DEPENDENCIES.has(packageName)) {
        findings.push({
          source: `${formatPath(packageJsonPath)}#${field}`,
          packageName,
          version: String(versionSpec),
          reason: "direct dependency uses a blocked package name",
        });
      }
    }
  }

  return findings;
}

async function findBlockedLockfileDependencies(lockfilePath) {
  const lockfile = await readFile(lockfilePath, "utf8");
  const findings = [];

  for (const line of lockfile.split("\n")) {
    const packageEntry = line.match(/^\s{2}(.+)@([^@:\s(]+)(?:\([^)]*\))?:\s*$/);
    if (packageEntry) {
      const [, packageName, version] = packageEntry;
      if (isBlockedCoordinate(packageName, version)) {
        findings.push({
          source: formatPath(lockfilePath),
          packageName,
          version,
          reason: "lockfile resolves a blocked package version",
        });
      }
      continue;
    }

    const dependencyLine = line.match(/^\s+(.+):\s+([^()\s]+)(?:\([^)]*\))?\s*$/);
    if (dependencyLine) {
      const [, packageName, version] = dependencyLine;
      if (isBlockedCoordinate(packageName, version)) {
        findings.push({
          source: formatPath(lockfilePath),
          packageName,
          version,
          reason: "lockfile dependency points to a blocked package version",
        });
      }
    }
  }

  return findings;
}

function isBlockedCoordinate(packageName, version) {
  return BLOCKED_DEPENDENCIES.get(packageName)?.has(version) ?? false;
}

function formatFinding(finding) {
  return `- ${finding.source}: ${finding.packageName}@${finding.version} (${finding.reason})`;
}

function formatPath(path) {
  return relative(repoRoot, path);
}

main().catch((error) => {
  console.error("verify-dependency-denylist.mjs failed:", error);
  process.exit(1);
});
