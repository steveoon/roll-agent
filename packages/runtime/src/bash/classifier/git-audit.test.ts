import { test } from "node:test";
import assert from "node:assert/strict";
import { auditGit } from "./git-audit.ts";

test("只读子命令 safe", () => {
  assert.equal(auditGit(["git", "status"]), "safe");
  assert.equal(auditGit(["git", "log", "-p"]), "safe");
  assert.equal(auditGit(["git", "diff", "HEAD~1"]), "safe");
  assert.equal(auditGit(["git", "show"]), "safe");
});

test("非白名单子命令 reject", () => {
  assert.equal(auditGit(["git", "commit", "-m", "x"]), "reject");
  assert.equal(auditGit(["git", "checkout", "status"]), "reject");
  assert.equal(auditGit(["git", "push"]), "reject");
});

test("危险全局选项 reject（Exact/贴值/前缀三态）", () => {
  assert.equal(auditGit(["git", "-C", "/x", "status"]), "reject");
  assert.equal(auditGit(["git", "-C.", "status"]), "reject");
  assert.equal(auditGit(["git", "-ccore.pager=cat", "log"]), "reject");
  assert.equal(auditGit(["git", "--git-dir=/x", "status"]), "reject");
  assert.equal(auditGit(["git", "-p", "log"]), "reject");
});

test("子命令写文件/外部命令选项 reject", () => {
  assert.equal(auditGit(["git", "log", "--output=f"]), "reject");
  assert.equal(auditGit(["git", "diff", "--ext-diff"]), "reject");
});

test("git branch 仅只读 flag safe，写操作 reject", () => {
  assert.equal(auditGit(["git", "branch"]), "safe");
  assert.equal(auditGit(["git", "branch", "--list"]), "safe");
  assert.equal(auditGit(["git", "branch", "-a"]), "safe");
  assert.equal(auditGit(["git", "branch", "--format=%(refname)"]), "safe");
  assert.equal(auditGit(["git", "branch", "-D", "feature"]), "reject");
  assert.equal(auditGit(["git", "branch", "new-branch"]), "reject");
});
