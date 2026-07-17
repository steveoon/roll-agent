import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectGitVcsContext, parseGitStatusSnapshot } from "./vcs-context.ts";

test("parseGitStatusSnapshot 只保留 branch/dirty/ahead/behind，不暴露文件名", () => {
  const snapshot = parseGitStatusSnapshot(
    "## feature/checkpoint...origin/feature/checkpoint [ahead 2, behind 1]\n M secret-name.txt\n?? token.env\n",
  );

  assert.deepEqual(snapshot, {
    branch: "feature/checkpoint",
    dirty: true,
    ahead: 2,
    behind: 1,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-name|token\.env/u);
});

test("parseGitStatusSnapshot 支持 unborn/detached/clean", () => {
  assert.deepEqual(parseGitStatusSnapshot("## No commits yet on main\n"), {
    branch: "main",
    dirty: false,
  });
  assert.deepEqual(parseGitStatusSnapshot("## HEAD (no branch)\n"), {
    dirty: false,
  });
  assert.equal(parseGitStatusSnapshot(""), undefined);
});

test("inspectGitVcsContext 非仓库或探测失败时 fail open", async () => {
  assert.equal(await inspectGitVcsContext("/path/that/does/not/exist", 100), undefined);
});
