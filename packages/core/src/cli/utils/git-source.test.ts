import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isGitUrl, repoNameFromUrl } from "./git-source.ts";

describe("isGitUrl", () => {
  it("识别 https/http/git@/.git 形式", () => {
    assert.equal(isGitUrl("https://github.com/org/repo"), true);
    assert.equal(isGitUrl("http://git.example.com/org/repo"), true);
    assert.equal(isGitUrl("git@github.com:org/repo.git"), true);
    assert.equal(isGitUrl("ssh://git.example.com/org/repo.git"), true);
  });

  it("普通路径与包名不是 Git URL", () => {
    assert.equal(isGitUrl("./local/dir"), false);
    assert.equal(isGitUrl("/abs/path"), false);
    assert.equal(isGitUrl("@roll-agent/core"), false);
    assert.equal(isGitUrl("some-package"), false);
  });
});

describe("repoNameFromUrl", () => {
  it("提取仓库名并去掉 .git 后缀", () => {
    assert.equal(repoNameFromUrl("https://github.com/org/my-repo.git"), "my-repo");
    assert.equal(repoNameFromUrl("https://github.com/org/my-repo"), "my-repo");
    assert.equal(repoNameFromUrl("git@github.com:org/other.git"), "other");
  });
});
