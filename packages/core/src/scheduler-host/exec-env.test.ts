import { test } from "node:test";
import assert from "node:assert/strict";
import { applySchedulerConfigEnv, prependExecDirToPath, takeScheduleExecEnv } from "./exec-env.ts";
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

test("prependExecDirToPath 把 exec 目录前置进 PATH，已在首位则幂等", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  prependExecDirToPath(env, "/opt/homebrew/bin/node", "darwin");
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
  prependExecDirToPath(env, "/opt/homebrew/bin/node", "darwin");
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
});

test("prependExecDirToPath 在无 PATH 时直接创建", () => {
  const env: NodeJS.ProcessEnv = {};
  prependExecDirToPath(env, "/opt/node/bin/node", "linux");
  assert.equal(env.PATH, "/opt/node/bin");
});

test("prependExecDirToPath 在 win32 下识别 Path 大小写变体并用分号分隔", () => {
  const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\system32" };
  prependExecDirToPath(env, "C:\\Program Files\\nodejs\\node.exe", "win32");
  assert.equal(env.Path, "C:\\Program Files\\nodejs;C:\\Windows\\system32");
  assert.equal(env.PATH, undefined);
});

test("applySchedulerConfigEnv 合入用户段并覆盖同名值，空段 no-op", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", KEEP: "1" };
  applySchedulerConfigEnv(env, { HTTP_PROXY: "http://127.0.0.1:7890", PATH: "/custom/bin" });
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.PATH, "/custom/bin");
  assert.equal(env.KEEP, "1");
  const untouched: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  applySchedulerConfigEnv(untouched, {});
  assert.deepEqual(untouched, { PATH: "/usr/bin" });
});
