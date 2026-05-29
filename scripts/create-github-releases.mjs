#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PUBLISHED_PACKAGES } from "./published-packages.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const dryRun =
  process.argv.includes("--dry-run") || process.env["ROLL_AGENT_RELEASE_DRY_RUN"] === "1";
const githubApiUrl = process.env["GITHUB_API_URL"] ?? "https://api.github.com";
const githubToken = process.env["GITHUB_TOKEN"];

async function main() {
  const repository = await resolveGitHubRepository();
  const targetCommitish = await resolveTargetCommitish();
  const candidates = await readReleaseCandidates();

  if (dryRun) {
    for (const candidate of candidates) {
      console.log(
        `Would ensure GitHub release ${candidate.tagName} at ${targetCommitish} in ${repository}`,
      );
    }
    return;
  }

  assert.ok(githubToken, "GITHUB_TOKEN is required to create GitHub releases");

  for (const candidate of candidates) {
    const existingRelease = await getReleaseByTag(repository, candidate.tagName);
    if (existingRelease !== null) {
      console.log(`GitHub release ${candidate.tagName} already exists; skipping.`);
      continue;
    }

    await createRelease(repository, candidate, targetCommitish);
    console.log(`Created GitHub release ${candidate.tagName}.`);
  }
}

async function readReleaseCandidates() {
  const candidates = [];

  for (const pkg of PUBLISHED_PACKAGES) {
    const packageJsonPath = resolve(repoRoot, pkg.packageJson);
    const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
    assert.equal(manifest.name, pkg.name);
    assert.equal(typeof manifest.version, "string", `${pkg.name} package.json is missing version`);

    const changelogPath = resolve(dirname(packageJsonPath), "CHANGELOG.md");
    const changelog = await readFile(changelogPath, "utf8");
    const tagName = buildReleaseTag(manifest.name, manifest.version);
    const changelogEntry =
      extractChangelogEntry(changelog, manifest.version) ?? `Published ${tagName}.`;

    candidates.push({
      packageName: manifest.name,
      version: manifest.version,
      tagName,
      releaseName: tagName,
      body: changelogEntry,
      prerelease: manifest.version.includes("-"),
    });
  }

  return candidates;
}

export function buildReleaseTag(packageName, version) {
  return `${packageName}@${version}`;
}

export function extractChangelogEntry(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(version)}\\s*$`);
  const startIndex = lines.findIndex((line) => headingPattern.test(line.trim()));

  if (startIndex === -1) {
    return undefined;
  }

  const endIndex = lines.findIndex((line, index) => index > startIndex && /^##\s+/.test(line));
  const bodyLines = lines.slice(startIndex + 1, endIndex === -1 ? undefined : endIndex);
  const body = bodyLines.join("\n").trim();
  return body.length > 0 ? body : undefined;
}

export function parseGitHubRepository(value) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid GitHub repository ${JSON.stringify(value)}; expected owner/repo`);
  }
  return value;
}

async function resolveGitHubRepository() {
  const envRepository = process.env["GITHUB_REPOSITORY"];
  if (envRepository !== undefined && envRepository.length > 0) {
    return parseGitHubRepository(envRepository);
  }

  const changesetConfig = JSON.parse(
    await readFile(resolve(repoRoot, ".changeset/config.json"), "utf8"),
  );
  const changelogConfig = changesetConfig.changelog;
  const repo =
    Array.isArray(changelogConfig) &&
    typeof changelogConfig[1] === "object" &&
    changelogConfig[1] !== null &&
    !Array.isArray(changelogConfig[1]) &&
    typeof changelogConfig[1].repo === "string"
      ? changelogConfig[1].repo
      : undefined;

  assert.ok(repo, "GITHUB_REPOSITORY is not set and .changeset/config.json has no repo");
  return parseGitHubRepository(repo);
}

async function resolveTargetCommitish() {
  const envSha = process.env["GITHUB_SHA"];
  if (envSha !== undefined && envSha.length > 0) {
    return envSha;
  }

  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

async function getReleaseByTag(repository, tagName) {
  const response = await githubRequest(
    "GET",
    `/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`,
  );
  if (response.status === 404) {
    return null;
  }
  await assertGitHubOk(response);
  return await response.json();
}

async function createRelease(repository, candidate, targetCommitish) {
  const response = await githubRequest("POST", `/repos/${repository}/releases`, {
    tag_name: candidate.tagName,
    target_commitish: targetCommitish,
    name: candidate.releaseName,
    body: candidate.body,
    draft: false,
    prerelease: candidate.prerelease,
  });
  await assertGitHubOk(response);
}

async function githubRequest(method, path, body = undefined) {
  const baseUrl = githubApiUrl.endsWith("/") ? githubApiUrl : `${githubApiUrl}/`;
  const url = new URL(path.replace(/^\//, ""), baseUrl);
  return await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "roll-agent-release",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function assertGitHubOk(response) {
  if (response.ok) {
    return;
  }

  const text = await response.text();
  throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}\n${text}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const entryPointUrl =
  process.argv[1] !== undefined ? pathToFileURL(process.argv[1]).href : undefined;

if (import.meta.url === entryPointUrl) {
  main().catch((error) => {
    console.error("create-github-releases.mjs failed:", error);
    process.exit(1);
  });
}
