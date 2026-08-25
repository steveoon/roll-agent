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

test("PATH 上伪造的 ps 不能把存活的 executor 判成 zombie（探活只信任绝对路径的 ps）", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 没有 ps");
    return;
  }
  const identity = currentExecutorIdentity();
  if (identity === undefined) {
    t.skip("当前平台无法读取进程启动身份");
    return;
  }
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const shadowDir = mkdtempSync(join(tmpdir(), "roll-ps-shadow-"));
  try {
    const fakePs = join(shadowDir, "ps");
    writeFileSync(fakePs, "#!/bin/sh\necho Z\n", { mode: 0o700 });
    chmodSync(fakePs, 0o700);
    const probed = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import { probeExecutorLiveness } from ${JSON.stringify(new URL("./executor-liveness.ts", import.meta.url).pathname)};
         console.log(probeExecutorLiveness({ pid: ${String(process.pid)}, startToken: ${JSON.stringify(identity.startToken)} }));`,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${shadowDir}:${process.env.PATH ?? ""}` },
      },
    );
    assert.equal(probed.stdout.trim(), EXECUTOR_LIVENESS.alive, probed.stderr);
    const shadowWorks = spawnSync("ps", ["-p", String(process.pid), "-o", "stat="], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${shadowDir}:${process.env.PATH ?? ""}` },
    });
    assert.equal(shadowWorks.stdout.trim(), "Z", "fake ps should shadow PATH lookups");
  } finally {
    rmSync(shadowDir, { recursive: true, force: true });
  }
});
