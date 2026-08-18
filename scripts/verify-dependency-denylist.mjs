#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  ["keyv", new Set(["6.0.0"])],
  ["flat-cache", new Set(["6.1.24"])],
  ["file-entry-cache", new Set(["11.1.6"])],
  ["cacheable-request", new Set(["13.0.20"])],
  ["cacheable", new Set(["2.5.1"])],
  ["@cacheable/memory", new Set(["2.2.1"])],
  ["cache-manager", new Set(["7.2.10"])],
  ["@cacheable/node-cache", new Set(["3.1.2"])],
  ["@cacheable/utils", new Set(["2.5.1"])],
  ["@cacheable/net", new Set(["2.1.1"])],
  ["ecto", new Set(["5.0.1"])],
]);
const BLOCKED_DIRECT_DEPENDENCY_NAMES = new Set(["node-ipc"]);

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
      const version = String(versionSpec);
      if (isBlockedDirectDependency(packageName, version)) {
        findings.push({
          source: `${formatPath(packageJsonPath)}#${field}`,
          packageName,
          version,
          reason: BLOCKED_DIRECT_DEPENDENCY_NAMES.has(packageName)
            ? "direct dependency uses a blocked package name"
            : "direct dependency pins a blocked package version",
        });
      }
    }
  }

  return findings;
}

async function findBlockedLockfileDependencies(lockfilePath) {
  const lockfile = await readFile(lockfilePath, "utf8");
  return findBlockedLockfileCoordinates(lockfile).map((finding) => ({
    ...finding,
    source: formatPath(lockfilePath),
  }));
}

export function findBlockedLockfileCoordinates(lockfile) {
  const findings = [];

  for (const line of lockfile.split("\n")) {
    const snapshot = parsePackagesSnapshotKey(line);
    if (snapshot) {
      if (isBlockedCoordinate(snapshot.packageName, snapshot.version)) {
        findings.push({
          packageName: snapshot.packageName,
          version: snapshot.version,
          reason: "lockfile resolves a blocked package version",
        });
      }
      continue;
    }

    const dependency = parseLockfileDependencyLine(line);
    if (dependency && isBlockedCoordinate(dependency.packageName, dependency.version)) {
      findings.push({
        packageName: dependency.packageName,
        version: dependency.version,
        reason: "lockfile dependency points to a blocked package version",
      });
    }
  }

  return findings;
}

function parsePackagesSnapshotKey(line) {
  const match = line.match(/^ {2}(\S.*):\s*$/);
  if (!match) {
    return null;
  }

  const key = stripPeerSuffix(stripYamlScalarQuotes(match[1]));
  const separator = key.lastIndexOf("@");
  if (separator <= 0) {
    return null;
  }

  const packageName = key.slice(0, separator);
  const version = key.slice(separator + 1);
  if (packageName.length === 0 || version.length === 0) {
    return null;
  }

  return { packageName, version };
}

function parseLockfileDependencyLine(line) {
  const match = line.match(/^\s{4,}(.+):\s+(\S+)\s*$/);
  if (!match) {
    return null;
  }

  const packageName = stripYamlScalarQuotes(match[1]);
  const version = stripPeerSuffix(stripYamlScalarQuotes(match[2]));
  if (packageName.length === 0 || version.length === 0) {
    return null;
  }

  return { packageName, version };
}

function stripPeerSuffix(value) {
  const parenIndex = value.indexOf("(");
  return parenIndex === -1 ? value : value.slice(0, parenIndex);
}

function stripYamlScalarQuotes(value) {
  if (value.length < 2) {
    return value;
  }

  const start = value[0];
  const end = value[value.length - 1];
  if ((start === "'" && end === "'") || (start === '"' && end === '"')) {
    return value.slice(1, -1);
  }

  return value;
}

export function isBlockedCoordinate(packageName, version) {
  return BLOCKED_DEPENDENCIES.get(packageName)?.has(version) ?? false;
}

export function isBlockedDirectDependency(packageName, versionSpec) {
  return (
    BLOCKED_DIRECT_DEPENDENCY_NAMES.has(packageName) ||
    isBlockedCoordinate(packageName, String(versionSpec))
  );
}

function formatFinding(finding) {
  return `- ${finding.source}: ${finding.packageName}@${finding.version} (${finding.reason})`;
}

function formatPath(path) {
  return relative(repoRoot, path);
}

const entryPointUrl =
  process.argv[1] !== undefined ? pathToFileURL(process.argv[1]).href : undefined;

if (import.meta.url === entryPointUrl) {
  main().catch((error) => {
    console.error("verify-dependency-denylist.mjs failed:", error);
    process.exit(1);
  });
}
