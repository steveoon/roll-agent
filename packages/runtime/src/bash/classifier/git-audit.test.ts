import { test } from "node:test";
import assert from "node:assert/strict";
import { auditGit } from "./git-audit.ts";

test("Git 命令始终降级确认，因为本地配置可能执行外部 helper", () => {
  for (const argv of [
    ["git", "status"],
    ["git", "branch", "--show-current"],
    ["git", "log", "-p"],
    ["git", "diff", "HEAD~1"],
    ["git", "show", "HEAD:src/index.ts"],
  ]) {
    assert.equal(auditGit(argv, process.cwd()), "reject", argv.join(" "));
  }
});
