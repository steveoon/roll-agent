import { test } from "node:test";
import assert from "node:assert/strict";
import { withAutoApprovedShellEnv, withCleanEnv, CLEAN_EXEC_ENV } from "./clean-env.ts";

test("withCleanEnv 叠加机器可读环境变量并保留原有键", () => {
  const merged = withCleanEnv({ PATH: "/usr/bin", TERM: "xterm-256color" });
  assert.equal(merged.PATH, "/usr/bin");
  assert.equal(merged.NO_COLOR, "1");
  assert.equal(merged.TERM, "dumb");
  assert.equal(merged.PAGER, "cat");
  assert.equal(merged.GIT_PAGER, "cat");
  assert.equal(merged.LANG, "C.UTF-8");
});

test("CLEAN_EXEC_ENV 覆盖颜色/分页/locale", () => {
  assert.equal(CLEAN_EXEC_ENV.NO_COLOR, "1");
  assert.equal(CLEAN_EXEC_ENV.TERM, "dumb");
});

test("auto-approved shell 使用固定 PATH 且移除启动/loader 注入变量", () => {
  const merged = withAutoApprovedShellEnv({
    PATH: "/tmp/shadow:/usr/bin",
    SHELL: "/tmp/custom-shell",
    BASH_ENV: "/tmp/bash-env",
    ENV: "/tmp/sh-env",
    BASH_FUNC_cat: "() { echo shadow; }",
    LD_PRELOAD: "/tmp/inject.so",
    DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
    KEEP_ME: "yes",
  });

  assert.equal(merged.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(merged.SHELL, "/bin/sh");
  assert.equal(merged.BASH_ENV, undefined);
  assert.equal(merged.ENV, undefined);
  assert.equal(merged.BASH_FUNC_cat, undefined);
  assert.equal(merged.LD_PRELOAD, undefined);
  assert.equal(merged.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(merged.KEEP_ME, "yes");
});
