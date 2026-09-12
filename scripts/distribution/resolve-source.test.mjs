import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDistributionSource } from "./resolve-source.mjs";

function repository(t, version = "1.2.3") {
  const root = mkdtempSync(join(tmpdir(), "roll-distribution-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hooks = join(root, "empty-hooks");
  mkdirSync(hooks);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Distribution Test",
        "-c",
        "user.email=distribution@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${hooks}`,
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "--initial-branch=main", "--object-format=sha1");
  const writeManifest = (nextVersion, name = "@roll-agent/core") => {
    mkdirSync(join(root, "packages/core"), { recursive: true });
    writeFileSync(
      join(root, "packages/core/package.json"),
      JSON.stringify({ name, version: nextVersion }),
    );
  };
  const commit = (message) => {
    git("add", ".");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  writeManifest(version);
  const release = commit("release source");
  return { root, git, writeManifest, commit, release };
}

for (const annotated of [false, true]) {
  test(`production recovery pins the original ${annotated ? "annotated" : "lightweight"} release tag after same-version code changes`, (t) => {
    const repo = repository(t);
    repo.git(
      "-c",
      "tag.gpgsign=false",
      "tag",
      ...(annotated ? ["-a", "-m", "release"] : []),
      "@roll-agent/core@1.2.3",
    );
    writeFileSync(join(repo.root, "unreleased.txt"), "must not be packaged into 1.2.3");
    const newerHead = repo.commit("later code without a version bump");
    assert.notEqual(newerHead, repo.release);
    assert.deepEqual(resolveDistributionSource(repo.root, { published: true }), {
      sha: repo.release,
      version: "1.2.3",
    });
    assert.deepEqual(resolveDistributionSource(repo.root, { published: false }), {
      sha: newerHead,
      version: "1.2.3",
    });
  });
}

test("publication requires a release tag, while unpublished previews use HEAD", (t) => {
  const repo = repository(t);
  assert.throws(
    () => resolveDistributionSource(repo.root, { published: true }),
    /published Core release tag is required/,
  );
  assert.equal(resolveDistributionSource(repo.root).sha, repo.release);
});

test("release tag must contain the requested Core version and package identity", (t) => {
  const repo = repository(t, "1.2.2");
  repo.git("-c", "tag.gpgsign=false", "tag", "@roll-agent/core@1.2.3");
  repo.writeManifest("1.2.3");
  repo.commit("next version");
  assert.throws(
    () => resolveDistributionSource(repo.root, { published: true }),
    /does not contain @roll-agent\/core@1.2.3/,
  );
  repo.writeManifest("1.2.3", "@roll-agent/other");
  assert.throws(() => resolveDistributionSource(repo.root), /Expected the Core package/);
});

test("publication rejects tags on an unrelated history", (t) => {
  const repo = repository(t);
  repo.git("checkout", "--orphan", "unrelated");
  repo.commit("unrelated source");
  repo.git("-c", "tag.gpgsign=false", "tag", "@roll-agent/core@1.2.3");
  repo.git("checkout", "main");
  assert.throws(() => resolveDistributionSource(repo.root, { published: true }), /not an ancestor/);
});
