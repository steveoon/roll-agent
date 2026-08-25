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

test("父进程未回收的僵尸子进程探活为 dead（POSIX）", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 没有僵尸进程语义");
    return;
  }
  const identity = currentExecutorIdentity();
  if (identity === undefined) {
    t.skip("当前平台无法读取进程启动身份");
    return;
  }
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  await delay(200);
  const pid = child.pid;
  assert.ok(pid);
  const token = (await import("../registry/process-identity.ts")).readProcessStartToken(pid);
  assert.ok(token);
  assert.equal(probeExecutorLiveness({ pid, startToken: token }), EXECUTOR_LIVENESS.alive);
  const reaped = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGKILL");
  const { spawnSync } = await import("node:child_process");
  const probedWhileBlocked = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { probeExecutorLiveness } from ${JSON.stringify(new URL("./executor-liveness.ts", import.meta.url).pathname)};
       const started = Date.now();
       while (Date.now() - started < 1500) {
         const result = probeExecutorLiveness({ pid: ${String(pid)}, startToken: ${JSON.stringify(token)} });
         if (result === "dead") { console.log(result); process.exit(0); }
       }
       console.log("still-alive");`,
    ],
    { encoding: "utf-8" },
  );
  assert.equal(probedWhileBlocked.stdout.trim(), "dead", probedWhileBlocked.stderr);
  await reaped;
});
