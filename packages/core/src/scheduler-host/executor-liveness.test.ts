import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { EXECUTOR_LIVENESS } from "@roll-agent/runtime";
import {
  KILL_PROCESS_TREE_OUTCOMES,
  currentExecutorIdentity,
  killProcessTree,
  probeExecutorLiveness,
  readExecutorIdentityWithRetry,
  terminateExecutor,
  terminateExecutorWithGrace,
} from "./executor-liveness.ts";

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

test("PID 被新进程组复用且启动 token mismatch 时绝不提升为 descendants 或发送信号", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 没有 POSIX 进程组语义");
    return;
  }
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { readProcessStartToken } = await import("../registry/process-identity.ts");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  assert.ok(pid);
  try {
    await delay(100);
    const currentToken = readProcessStartToken(pid);
    if (currentToken === undefined) {
      t.skip("当前平台无法读取进程启动身份");
      return;
    }
    const replacement = currentToken.endsWith("0") ? "1" : "0";
    const staleToken = `${currentToken.slice(0, -1)}${replacement}`;
    const staleExecutor = { pid, startToken: staleToken };
    const killed: Array<{ readonly pid: number; readonly signal: NodeJS.Signals }> = [];

    assert.equal(probeExecutorLiveness(staleExecutor), EXECUTOR_LIVENESS.dead);
    assert.equal(
      terminateExecutor(staleExecutor, "SIGKILL", {
        platform: process.platform,
        kill: (target, signal) => killed.push({ pid: target, signal }),
      }),
      KILL_PROCESS_TREE_OUTCOMES.failed,
    );
    assert.deepEqual(killed, []);
    assert.equal(probeExecutorLiveness({ pid, startToken: currentToken }), EXECUTOR_LIVENESS.alive);
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    await once(child, "exit");
  }
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

test("killProcessTree：Windows taskkill 非零/缺失时返回 failed 且不退回根 PID；成功返回 tree；SIGTERM 不带 /F", () => {
  const killed: Array<[number, string]> = [];
  const calls: string[][] = [];
  const fakeSpawn = (status: number | null, error?: Error) =>
    ((_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return { status, error, stdout: "", stderr: "", pid: 1, output: [], signal: null } as never;
    }) as unknown as typeof spawnSync;
  const deps = (status: number | null, error?: Error) => ({
    platform: "win32" as const,
    env: { SystemRoot: "C:\\Windows" },
    spawnSync: fakeSpawn(status, error),
    kill: (pid: number, signal: NodeJS.Signals) => {
      killed.push([pid, signal]);
    },
  });
  assert.equal(killProcessTree(4242, "SIGKILL", deps(1)), KILL_PROCESS_TREE_OUTCOMES.failed);
  assert.equal(
    killProcessTree(4242, "SIGKILL", deps(null, new Error("spawn failed"))),
    KILL_PROCESS_TREE_OUTCOMES.failed,
  );
  assert.equal(killProcessTree(4242, "SIGKILL", deps(0)), KILL_PROCESS_TREE_OUTCOMES.tree);
  assert.equal(killProcessTree(4242, "SIGTERM", deps(0)), KILL_PROCESS_TREE_OUTCOMES.tree);
  assert.deepEqual(calls[0], ["/T", "/F", "/PID", "4242"]);
  assert.deepEqual(calls[3], ["/T", "/PID", "4242"]);
  assert.deepEqual(killed, []);
  assert.equal(
    killProcessTree(4242, "SIGKILL", { ...deps(0), env: {} }),
    KILL_PROCESS_TREE_OUTCOMES.failed,
  );
  assert.equal(calls.length, 4);
});

test("killProcessTree：POSIX 进程组信号失败时返回 failed，不单独杀根进程", () => {
  const killed: Array<[number, string]> = [];
  const outcome = killProcessTree(4242, "SIGKILL", {
    platform: "darwin",
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      if (pid < 0) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
    },
  });
  assert.equal(outcome, KILL_PROCESS_TREE_OUTCOMES.failed);
  assert.deepEqual(killed, [[-4242, "SIGKILL"]]);
  const ok = killProcessTree(4242, "SIGTERM", {
    platform: "linux",
    kill: (pid, signal) => {
      killed.push([pid, signal]);
    },
  });
  assert.equal(ok, KILL_PROCESS_TREE_OUTCOMES.tree);
  assert.deepEqual(killed[1], [-4242, "SIGTERM"]);
});

test("terminateExecutorWithGrace：POSIX 先 SIGTERM，grace 内证实退出就不再 SIGKILL", async () => {
  const signals: NodeJS.Signals[] = [];
  let waits = 0;
  const outcome = await terminateExecutorWithGrace(
    { pid: 4242, startToken: "pst-v2:root" },
    {
      platform: "linux",
      graceMs: 1_000,
      terminate: (_executor, signal) => {
        signals.push(signal);
        return KILL_PROCESS_TREE_OUTCOMES.tree;
      },
      waitForExit: async (_executor, timeoutMs) => {
        waits += 1;
        assert.equal(timeoutMs, 1_000);
        return EXECUTOR_LIVENESS.dead;
      },
    },
  );

  assert.equal(outcome, KILL_PROCESS_TREE_OUTCOMES.tree);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(waits, 1);
});

test("terminateExecutorWithGrace：POSIX grace 后仍存活才重新验身份并升级 SIGKILL", async () => {
  const signals: NodeJS.Signals[] = [];
  const outcome = await terminateExecutorWithGrace(
    { pid: 4242, startToken: "pst-v2:root" },
    {
      platform: "darwin",
      graceMs: 20,
      terminate: (_executor, signal) => {
        signals.push(signal);
        return KILL_PROCESS_TREE_OUTCOMES.tree;
      },
      waitForExit: async () => EXECUTOR_LIVENESS.alive,
    },
  );

  assert.equal(outcome, KILL_PROCESS_TREE_OUTCOMES.tree);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("terminateExecutorWithGrace：SIGTERM 未确认投递时跳过无意义 grace 并立即升级", async () => {
  const signals: NodeJS.Signals[] = [];
  const outcome = await terminateExecutorWithGrace(
    { pid: 4242, startToken: "pst-v2:unknown" },
    {
      platform: "linux",
      terminate: (_executor, signal) => {
        signals.push(signal);
        return KILL_PROCESS_TREE_OUTCOMES.failed;
      },
      waitForExit: async () => {
        assert.fail("failed SIGTERM must not consume the cooperative grace window");
      },
    },
  );

  assert.equal(outcome, KILL_PROCESS_TREE_OUTCOMES.failed);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("terminateExecutorWithGrace：Windows 保持立即 SIGKILL，不进入 POSIX grace", async () => {
  const signals: NodeJS.Signals[] = [];
  const outcome = await terminateExecutorWithGrace(
    { pid: 4242, startToken: "pst-v2:root" },
    {
      platform: "win32",
      terminate: (_executor, signal) => {
        signals.push(signal);
        return KILL_PROCESS_TREE_OUTCOMES.tree;
      },
      waitForExit: async () => {
        assert.fail("Windows termination must not wait for POSIX grace");
      },
    },
  );

  assert.equal(outcome, KILL_PROCESS_TREE_OUTCOMES.tree);
  assert.deepEqual(signals, ["SIGKILL"]);
});

test("根进程退出但同进程组后代仍存活 → descendants-alive；整组终止后 → dead（POSIX）", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 没有进程组语义");
    return;
  }
  const identity = currentExecutorIdentity();
  if (identity === undefined) {
    t.skip("当前平台无法读取进程启动身份");
    return;
  }
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { readProcessStartToken } = await import("../registry/process-identity.ts");
  const root = spawn(
    process.execPath,
    [
      "-e",
      'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }); setTimeout(() => process.exit(0), 700);',
    ],
    { stdio: "ignore", detached: true },
  );
  const rootPid = root.pid;
  assert.ok(rootPid);
  try {
    await delay(150);
    const token = readProcessStartToken(rootPid);
    assert.ok(token);
    assert.equal(
      probeExecutorLiveness({ pid: rootPid, startToken: token }),
      EXECUTOR_LIVENESS.alive,
    );
    await once(root, "exit");
    await delay(100);
    assert.equal(
      probeExecutorLiveness({ pid: rootPid, startToken: token }),
      EXECUTOR_LIVENESS.descendants,
    );
    assert.equal(
      terminateExecutor({ pid: rootPid, startToken: token }),
      KILL_PROCESS_TREE_OUTCOMES.tree,
    );
    const deadline = Date.now() + 3_000;
    let liveness = probeExecutorLiveness({ pid: rootPid, startToken: token });
    while (liveness !== EXECUTOR_LIVENESS.dead && Date.now() < deadline) {
      await delay(50);
      liveness = probeExecutorLiveness({ pid: rootPid, startToken: token });
    }
    assert.equal(liveness, EXECUTOR_LIVENESS.dead);
  } finally {
    try {
      process.kill(-rootPid, "SIGKILL");
    } catch {
      // group already gone
    }
  }
});

test("readExecutorIdentityWithRetry：首次失败后重读一次，连续失败才返回 undefined", () => {
  let calls = 0;
  const flaky = () => {
    calls += 1;
    return calls === 1 ? undefined : { pid: 7, startToken: "pst-v2:x" };
  };
  assert.deepEqual(readExecutorIdentityWithRetry(flaky), { pid: 7, startToken: "pst-v2:x" });
  assert.equal(calls, 2);
  let failures = 0;
  assert.equal(
    readExecutorIdentityWithRetry(() => {
      failures += 1;
      return undefined;
    }),
    undefined,
  );
  assert.equal(failures, 2);
});
