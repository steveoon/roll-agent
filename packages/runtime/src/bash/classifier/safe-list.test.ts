import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeExecutable, isTrustedExecutable } from "./safe-list.ts";

test("通用只读命令在所有平台命中", () => {
  for (const key of ["cat", "ls", "grep", "pwd", "wc", "whoami"]) {
    assert.equal(isSafeExecutable(key, "darwin"), true, key);
  }
});

test("未知命令不命中", () => {
  assert.equal(isSafeExecutable("rm", "linux"), false);
  assert.equal(isSafeExecutable("git", "linux"), false);
  assert.equal(isSafeExecutable("curl", "darwin"), false);
});

test("linux-only 命令仅 linux 命中", () => {
  assert.equal(isSafeExecutable("tac", "linux"), true);
  assert.equal(isSafeExecutable("numfmt", "linux"), true);
  assert.equal(isSafeExecutable("tac", "darwin"), false);
  assert.equal(isSafeExecutable("numfmt", "win32"), false);
});

test("auto approval 只解析固定 POSIX system PATH 或 shell builtin", () => {
  assert.equal(isTrustedExecutable("echo", "darwin"), true);
  assert.equal(isTrustedExecutable("cat", process.platform), process.platform !== "win32");
  assert.equal(isTrustedExecutable("roll-workspace-shadow", process.platform), false);
  assert.equal(isTrustedExecutable("cat", "win32"), false);
});
