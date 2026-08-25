import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EXECUTOR_LIVENESS } from "@roll-agent/runtime";
import { currentExecutorIdentity, probeExecutorLiveness } from "./executor-liveness.ts";

test("当前进程的 executor identity 探活为 alive", (t) => {
  const identity = currentExecutorIdentity();
  if (identity === undefined) {
    t.skip("当前平台无法读取进程启动身份");
    return;
  }
  assert.equal(identity.pid, process.pid);
  assert.equal(probeExecutorLiveness(identity), EXECUTOR_LIVENESS.alive);
});

test("已退出进程的 executor identity 探活为 dead；非法 token 为 unknown", (t) => {
  const identity = currentExecutorIdentity();
  if (identity === undefined) {
    t.skip("当前平台无法读取进程启动身份");
    return;
  }
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(exited.status, 0);
  assert.ok(exited.pid > 0);
  assert.equal(
    probeExecutorLiveness({ pid: exited.pid, startToken: identity.startToken }),
    EXECUTOR_LIVENESS.dead,
  );
  assert.equal(
    probeExecutorLiveness({ pid: process.pid, startToken: "not-a-token" }),
    EXECUTOR_LIVENESS.unknown,
  );
});
