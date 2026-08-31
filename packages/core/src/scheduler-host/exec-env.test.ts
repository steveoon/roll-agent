import { test } from "node:test";
import assert from "node:assert/strict";
import { takeScheduleExecEnv } from "./exec-env.ts";
import {
  omitScheduleInvocationEnv,
  SCHEDULE_DATA_DIR_ENV,
  SCHEDULE_INVOCATION_ENV,
  SCHEDULE_TOKEN_ENV,
} from "./paths.ts";

test("takeScheduleExecEnv 读取 token 与 data-dir 后立即从 env 删除", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    [SCHEDULE_TOKEN_ENV]: "tok-1",
    [SCHEDULE_DATA_DIR_ENV]: "/data/scheduler",
  };
  assert.deepEqual(takeScheduleExecEnv(env), {
    ownershipToken: "tok-1",
    dataDir: "/data/scheduler",
  });
  assert.equal(env[SCHEDULE_TOKEN_ENV], undefined);
  assert.equal(env[SCHEDULE_DATA_DIR_ENV], undefined);
  assert.equal(env.PATH, "/usr/bin");
});

test("takeScheduleExecEnv 缺少 token 或 data-dir 非绝对路径时抛错，且仍会清除 env", () => {
  const missingToken: NodeJS.ProcessEnv = { [SCHEDULE_DATA_DIR_ENV]: "/data" };
  assert.throws(() => takeScheduleExecEnv(missingToken), /ROLL_SCHEDULE_OWNERSHIP_TOKEN/u);
  assert.equal(missingToken[SCHEDULE_DATA_DIR_ENV], undefined);
  const relativeDir: NodeJS.ProcessEnv = {
    [SCHEDULE_TOKEN_ENV]: "tok",
    [SCHEDULE_DATA_DIR_ENV]: "relative/dir",
  };
  assert.throws(() => takeScheduleExecEnv(relativeDir), /ROLL_SCHEDULE_DATA_DIR/u);
  assert.equal(relativeDir[SCHEDULE_TOKEN_ENV], undefined);
});

test("omitScheduleInvocationEnv 去掉 ROLL_SCHEDULE_INVOCATION，其余 env 保留", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    [SCHEDULE_INVOCATION_ENV]: "inv-1",
    HOME: "/Users/x",
  };
  assert.deepEqual(omitScheduleInvocationEnv(env), { PATH: "/usr/bin", HOME: "/Users/x" });
  assert.equal(env[SCHEDULE_INVOCATION_ENV], "inv-1");
  const empty = omitScheduleInvocationEnv({ PATH: "/bin" });
  assert.deepEqual(empty, { PATH: "/bin" });
});
