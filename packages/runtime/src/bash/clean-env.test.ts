import { test } from "node:test";
import assert from "node:assert/strict";
import { withCleanEnv, CLEAN_EXEC_ENV } from "./clean-env.ts";

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
