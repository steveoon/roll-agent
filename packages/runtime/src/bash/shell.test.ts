import { test } from "node:test";
import assert from "node:assert/strict";
import { isBashToolSupported, resolveUserShell, type ShellResolutionDeps } from "./shell.ts";

function deps(overrides: Partial<ShellResolutionDeps>): ShellResolutionDeps {
  return {
    platform: "darwin",
    env: {},
    fileExists: () => true,
    ...overrides,
  };
}

test("isBashToolSupported 在 win32 返回 false，其余平台 true", () => {
  assert.equal(isBashToolSupported("win32"), false);
  assert.equal(isBashToolSupported("darwin"), true);
  assert.equal(isBashToolSupported("linux"), true);
});

test("优先返回存在的 $SHELL", () => {
  const shell = resolveUserShell(
    deps({ env: { SHELL: "/usr/bin/fish" }, fileExists: (p) => p === "/usr/bin/fish" }),
  );
  assert.equal(shell, "/usr/bin/fish");
});

test("$SHELL 不存在时按 zsh→bash 回退", () => {
  const shell = resolveUserShell(
    deps({ env: { SHELL: "/nope" }, fileExists: (p) => p === "/bin/bash" }),
  );
  assert.equal(shell, "/bin/bash");
});

test("全部候选缺失时回退 /bin/sh", () => {
  const shell = resolveUserShell(deps({ env: {}, fileExists: () => false }));
  assert.equal(shell, "/bin/sh");
});

test("空 $SHELL 视为未配置", () => {
  const shell = resolveUserShell(deps({ env: { SHELL: "" }, fileExists: (p) => p === "/bin/zsh" }));
  assert.equal(shell, "/bin/zsh");
});
