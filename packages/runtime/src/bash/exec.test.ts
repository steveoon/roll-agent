import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runBashCommand, type RunBashOptions } from "./exec.ts";
import { BASH_TERMINATION_CAUSES } from "./format-result.ts";
import { escalateKillGroup, killProcessGroup } from "./kill.ts";
import type { ShellProfile } from "./profile.ts";
import { TURN_TIMEOUT_ABORT_REASON } from "../types/cancellation.ts";
import { withAutoApprovedShellEnv } from "./clean-env.ts";

const skip = process.platform === "win32";
const MB = 1_048_576;

const profile: ShellProfile = {
  id: "posix",
  toolName: "bash",
  supportsSessionExec: true,
  supportsSafeCommandClassification: true,
  waitForTreeKillAfterRootExit: false,
  buildSpawn: (command, workdir, env) => ({
    file: "/bin/sh",
    args: ["-c", command],
    options: { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
  }),
  classify: () => "unknown",
  killTree: async (pid) => {
    escalateKillGroup(pid);
  },
  systemPromptHints: () => [],
};

function opts(overrides: Partial<RunBashOptions> & { command: string }): RunBashOptions {
  return {
    workdir: tmpdir(),
    timeoutMs: 15_000,
    maxCaptureBytes: MB,
    profile,
    ...overrides,
  };
}

function fakeExecChild(options: {
  readonly exitOnKill: boolean;
  readonly started?: boolean;
  readonly holdStreamsOpen?: boolean;
  readonly initialError?: Error;
  readonly errorOnKill?: Error;
  readonly onKill?: () => void;
  readonly onUnref?: () => void;
}): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    stdout: PassThrough | null;
    stderr: PassThrough | null;
    kill(signal?: NodeJS.Signals | number): boolean;
    unref(): void;
  };
  child.pid = options.started === false ? undefined : 4321;
  child.stdout = options.holdStreamsOpen ? new PassThrough() : null;
  child.stderr = options.holdStreamsOpen ? new PassThrough() : null;
  child.kill = () => {
    options.onKill?.();
    if (options.errorOnKill) {
      queueMicrotask(() => child.emit("error", options.errorOnKill));
    }
    if (options.exitOnKill) {
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
    }
    return options.errorOnKill === undefined;
  };
  child.unref = () => options.onUnref?.();
  if (options.initialError) {
    queueMicrotask(() => child.emit("error", options.initialError));
  }
  return child as unknown as ChildProcess;
}

function spawnReturning(child: ChildProcess): typeof import("node:child_process").spawn {
  return (() => child) as typeof import("node:child_process").spawn;
}

test("echo 成功返回 stdout 与 exit 0", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "echo hi" }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.text.trim(), "hi");
  assert.ok(result.wallTimeMs >= 0);
});

test("known-safe 环境实跑不执行 PATH shadow 或 BASH_ENV function", { skip }, async (context) => {
  const fixture = mkdtempSync(join(tmpdir(), "roll-safe-shell-env-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  const fakeBin = join(fixture, "bin");
  mkdirSync(fakeBin);
  const fakeCat = join(fakeBin, "cat");
  writeFileSync(fakeCat, "#!/bin/sh\nprintf PATH_SHADOW_EXECUTED\n");
  chmodSync(fakeCat, 0o755);
  const bashEnv = join(fixture, "bash-env.sh");
  writeFileSync(bashEnv, "cat() { printf BASH_ENV_EXECUTED; }\nexport -f cat\n");
  writeFileSync(join(fixture, "inside.txt"), "EXPECTED_SYSTEM_CAT");

  const result = await runBashCommand(
    opts({
      command: "cat inside.txt",
      workdir: fixture,
      env: withAutoApprovedShellEnv({
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        SHELL: "/bin/bash",
        BASH_ENV: bashEnv,
      }),
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.text, "EXPECTED_SYSTEM_CAT");
});

test("非零退出码透传", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "exit 7" }));
  assert.equal(result.exitCode, 7);
});

test("超时杀进程组并归一 124，快速返回", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "sleep 30", timeoutMs: 200 }));
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.equal(result.terminationCause, BASH_TERMINATION_CAUSES.timeout);
  assert.ok(result.wallTimeMs < 3_000, `wallTime=${String(result.wallTimeMs)}`);
});

test("daemon 子进程握住 stderr 时，2s 排干超时内返回", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "(sleep 3 &) ; echo done" }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.text.trim(), "done");
  assert.ok(result.wallTimeMs < 5_000, `wallTime=${String(result.wallTimeMs)}`);
});

test("超帽大输出不死锁，统计与截断正确", { skip }, async () => {
  const result = await runBashCommand(
    opts({ command: "yes aaaaaaaa | head -n 200000", maxCaptureBytes: MB }),
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.totalBytes > MB, `totalBytes=${String(result.stdout.totalBytes)}`);
  assert.equal(result.stdout.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout.text) <= MB);
});

test("AbortSignal 中止杀组并快速返回", { skip }, async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const result = await runBashCommand(
    opts({ command: "sleep 30", abortSignal: controller.signal }),
  );
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 130);
  assert.equal(result.terminationCause, BASH_TERMINATION_CAUSES.abort);
  assert.ok(result.wallTimeMs < 3_000, `wallTime=${String(result.wallTimeMs)}`);
});

test("after-spawn abort 即使命令退出 0 也固定返回 130", async () => {
  const controller = new AbortController();
  const child = fakeExecChild({ exitOnKill: false });
  const trapProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: async () => {
      queueMicrotask(() => child.emit("exit", 0, null));
    },
  };

  const command = runBashCommand(
    opts({
      command: "never-run",
      timeoutMs: 1_000,
      abortSignal: controller.signal,
      profile: trapProfile,
    }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 50,
      rootKillSettleTimeoutMs: 10,
    },
  );
  controller.abort();
  const result = await command;

  assert.equal(result.exitCode, 130);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationCause, BASH_TERMINATION_CAUSES.abort);
  assert.equal(result.spawnError, undefined);
});

test("initial precheck 后、spawn 前发生 abort 也不会漏掉快速 exit", async () => {
  const controller = new AbortController();
  const child = fakeExecChild({ exitOnKill: false });
  const raceProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => {
      controller.abort();
      return { file: "/fake/shell", args: [], options: {} };
    },
    killTree: async () => {
      queueMicrotask(() => child.emit("exit", 0, null));
    },
  };

  const result = await runBashCommand(
    opts({
      command: "never-run",
      timeoutMs: 1_000,
      abortSignal: controller.signal,
      profile: raceProfile,
    }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 50,
      rootKillSettleTimeoutMs: 10,
    },
  );

  assert.equal(result.exitCode, 130);
  assert.equal(result.timedOut, false);
});

test("abort 先于 timeout 时 first-cause 保持 130", async () => {
  const controller = new AbortController();
  const child = fakeExecChild({ exitOnKill: false });
  let releaseKillTree: (() => void) | undefined;
  const pendingProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: () =>
      new Promise<void>((resolve) => {
        releaseKillTree = resolve;
        queueMicrotask(() => child.emit("exit", 0, null));
      }),
  };

  const command = runBashCommand(
    opts({
      command: "never-run",
      timeoutMs: 10,
      abortSignal: controller.signal,
      profile: pendingProfile,
    }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 100,
      rootKillSettleTimeoutMs: 10,
    },
  );
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(releaseKillTree);
  releaseKillTree();
  const result = await command;

  assert.equal(result.exitCode, 130);
  assert.equal(result.timedOut, false);
});

test("timeout 先于 abort 时 first-cause 保持 124", async () => {
  const controller = new AbortController();
  const child = fakeExecChild({ exitOnKill: false });
  let releaseKillTree: (() => void) | undefined;
  let markKillStarted: (() => void) | undefined;
  const killStarted = new Promise<void>((resolve) => {
    markKillStarted = resolve;
  });
  const pendingProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: () =>
      new Promise<void>((resolve) => {
        releaseKillTree = resolve;
        markKillStarted?.();
      }),
  };

  const command = runBashCommand(
    opts({
      command: "never-run",
      timeoutMs: 5,
      abortSignal: controller.signal,
      profile: pendingProfile,
    }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 100,
      rootKillSettleTimeoutMs: 10,
    },
  );
  await killStarted;
  controller.abort();
  assert.ok(releaseKillTree);
  releaseKillTree();
  child.emit("exit", 0, null);
  const result = await command;

  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationCause, BASH_TERMINATION_CAUSES.timeout);
});

test("root 先退出时等待 killTree 完成，且不提前 abort 清理", async () => {
  const child = fakeExecChild({ exitOnKill: false });
  let releaseKillTree: (() => void) | undefined;
  let killTreeSignalAborted = false;
  let markKillStarted: (() => void) | undefined;
  const killStarted = new Promise<void>((resolve) => {
    markKillStarted = resolve;
  });
  const delayedProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: (_pid, _intent, options) =>
      new Promise<void>((resolve) => {
        releaseKillTree = resolve;
        options?.signal?.addEventListener("abort", () => {
          killTreeSignalAborted = true;
        });
        markKillStarted?.();
        queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      }),
  };

  let commandSettled = false;
  const command = runBashCommand(
    opts({ command: "never-run", timeoutMs: 5, profile: delayedProfile }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 1_000,
      rootKillSettleTimeoutMs: 10,
    },
  ).then((result) => {
    commandSettled = true;
    return result;
  });
  await killStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(commandSettled, false);
  assert.equal(killTreeSignalAborted, false);
  assert.ok(releaseKillTree);
  releaseKillTree();
  const result = await command;

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
});

test("真正 spawn failure 仍返回 spawnError", async () => {
  const child = fakeExecChild({
    exitOnKill: false,
    started: false,
    initialError: new Error("spawn fake-shell ENOENT"),
  });
  const result = await runBashCommand(
    opts({
      command: "never-run",
      timeoutMs: 1_000,
      profile: {
        ...profile,
        buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
      },
    }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 50,
      rootKillSettleTimeoutMs: 10,
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.match(result.spawnError ?? "", /ENOENT/u);
  assert.equal(result.terminationError, undefined);
});

test("预先 aborted 时不调用 profile.buildSpawn 或 spawn", async () => {
  const controller = new AbortController();
  controller.abort();
  let buildSpawnCalls = 0;
  let spawnCalls = 0;
  const result = await runBashCommand(
    opts({
      command: "never-run",
      abortSignal: controller.signal,
      profile: {
        ...profile,
        buildSpawn: () => {
          buildSpawnCalls += 1;
          throw new Error("buildSpawn 不应被调用");
        },
      },
    }),
    {
      spawn: (() => {
        spawnCalls += 1;
        throw new Error("spawn 不应被调用");
      }) as typeof import("node:child_process").spawn,
      killTreeDeadlineMs: 10,
      rootKillSettleTimeoutMs: 10,
    },
  );

  assert.equal(buildSpawnCalls, 0);
  assert.equal(spawnCalls, 0);
  assert.equal(result.exitCode, 130);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationCause, BASH_TERMINATION_CAUSES.abort);
  assert.equal(result.wallTimeMs, 0);
  assert.equal(result.spawnError, undefined);
  assert.equal(result.stdout.totalBytes, 0);
  assert.equal(result.stderr.totalBytes, 0);
});

test("预先 timeout abort 归一为 exit 124", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("The operation timed out", "TimeoutError"));
  const result = await runBashCommand(
    opts({ command: "never-run", abortSignal: controller.signal }),
  );
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationCause, BASH_TERMINATION_CAUSES.timeout);
});

test("仅含 timed out 文案的普通 Error 不冒充 Roll timeout", async () => {
  const controller = new AbortController();
  controller.abort(new Error("provider request timed out"));
  const result = await runBashCommand(
    opts({ command: "never-run", abortSignal: controller.signal }),
  );
  assert.equal(result.exitCode, 130);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationCause, BASH_TERMINATION_CAUSES.abort);
});

test("Roll turn timeout sentinel 归一为 exit 124", async () => {
  const controller = new AbortController();
  controller.abort(TURN_TIMEOUT_ABORT_REASON);
  const result = await runBashCommand(
    opts({ command: "never-run", abortSignal: controller.signal }),
  );
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationCause, BASH_TERMINATION_CAUSES.timeout);
});

test("killTree 永不 settle 时，独立 deadline 回退终止根进程", async () => {
  let rootKillCalls = 0;
  const child = fakeExecChild({
    exitOnKill: true,
    onKill: () => {
      rootKillCalls += 1;
    },
  });
  const hangingProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: () => new Promise<void>(() => {}),
  };

  const result = await runBashCommand(
    opts({ command: "never-run", timeoutMs: 5, profile: hangingProfile }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 10,
      rootKillSettleTimeoutMs: 10,
    },
  );

  assert.equal(rootKillCalls, 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.match(result.terminationError ?? "", /进程树清理超过独立期限/u);
  assert.match(result.terminationError ?? "", /无法确认后代进程是否已清理/u);
});

test("killTree 失败后 root fallback 成功退出仍保留进程树未确认状态", async () => {
  const child = fakeExecChild({ exitOnKill: true });
  const failedProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: async () => {
      throw new Error("taskkill.exe 执行失败: exitCode=5");
    },
  };

  const result = await runBashCommand(
    opts({ command: "never-run", timeoutMs: 5, profile: failedProfile }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 50,
      rootKillSettleTimeoutMs: 10,
    },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.match(result.terminationError ?? "", /taskkill\.exe 执行失败: exitCode=5/u);
  assert.match(result.terminationError ?? "", /仅向根进程发送强制终止请求/u);
  assert.match(result.terminationError ?? "", /无法确认后代进程是否已清理/u);
});

test("kill 阶段 child error 保持 timeout 语义并走 forced-settle", async () => {
  let unrefCalls = 0;
  const child = fakeExecChild({
    exitOnKill: false,
    errorOnKill: new Error("kill EPERM"),
    onUnref: () => {
      unrefCalls += 1;
    },
  });
  const failedProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: async () => {
      throw new Error("taskkill.exe 执行失败: exitCode=5");
    },
  };

  const result = await runBashCommand(
    opts({ command: "never-run", timeoutMs: 5, profile: failedProfile }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 50,
      rootKillSettleTimeoutMs: 10,
    },
  );

  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.spawnError, undefined);
  assert.equal(unrefCalls, 1);
  assert.match(result.terminationError ?? "", /kill EPERM/u);
  assert.match(result.terminationError ?? "", /根进程在强制终止请求后仍未确认退出/u);
});

test("fallback 后 root 已退出但流未 close 时不误报 root 未退出", async () => {
  let unrefCalls = 0;
  const child = fakeExecChild({
    exitOnKill: true,
    holdStreamsOpen: true,
    onUnref: () => {
      unrefCalls += 1;
    },
  });
  const failedProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: async () => {
      throw new Error("taskkill.exe 执行失败: exitCode=5");
    },
  };

  const result = await runBashCommand(
    opts({ command: "never-run", timeoutMs: 5, profile: failedProfile }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 50,
      rootKillSettleTimeoutMs: 5,
      ioDrainTimeoutMs: 20,
    },
  );

  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(unrefCalls, 0);
  assert.match(result.terminationError ?? "", /无法确认后代进程是否已清理/u);
  assert.doesNotMatch(result.terminationError ?? "", /根进程在强制终止请求后仍未确认退出/u);
});

test("killTree 已成功且 root 已退出时，流排干期间不再触发 fallback", async () => {
  let fallbackKillCalls = 0;
  const child = fakeExecChild({
    exitOnKill: false,
    holdStreamsOpen: true,
    onKill: () => {
      fallbackKillCalls += 1;
    },
  });
  const successfulProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: async () => {
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
    },
  };

  const result = await runBashCommand(
    opts({ command: "never-run", timeoutMs: 5, profile: successfulProfile }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 5,
      rootKillSettleTimeoutMs: 5,
      ioDrainTimeoutMs: 20,
    },
  );

  assert.equal(result.exitCode, 124);
  assert.equal(fallbackKillCalls, 0);
  assert.equal(result.terminationError, undefined);
});

test("killTree resolve 但目标不退出时 forced-settle 明确暴露未确认状态", async () => {
  let rootKillCalls = 0;
  let unrefCalls = 0;
  const child = fakeExecChild({
    exitOnKill: false,
    onKill: () => {
      rootKillCalls += 1;
    },
    onUnref: () => {
      unrefCalls += 1;
    },
  });
  const ineffectiveProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: () => ({ file: "/fake/shell", args: [], options: {} }),
    killTree: async () => {},
  };

  const result = await runBashCommand(
    opts({ command: "never-run", timeoutMs: 5, profile: ineffectiveProfile }),
    {
      spawn: spawnReturning(child),
      killTreeDeadlineMs: 10,
      rootKillSettleTimeoutMs: 10,
    },
  );

  assert.equal(rootKillCalls, 1);
  assert.equal(unrefCalls, 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.match(result.terminationError ?? "", /仍未确认退出/u);
  assert.match(result.terminationError ?? "", /无法确认后代进程是否已清理/u);
});

test("POSIX root 退出后立即取消延迟 SIGKILL 补刀", { skip }, async () => {
  let killSignalAborted = false;
  let delayedSigkillApplied = false;
  const cancellableProfile: ShellProfile = {
    ...profile,
    killTree: async (pid, intent, options) => {
      if (intent === "interrupt") {
        killProcessGroup(pid, "SIGINT");
        return;
      }
      killProcessGroup(pid, "SIGTERM");
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(graceTimer);
          options?.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          killSignalAborted = true;
          finish();
        };
        const graceTimer = setTimeout(() => {
          delayedSigkillApplied = true;
          killProcessGroup(pid, "SIGKILL");
          finish();
        }, 500);
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        if (options?.signal?.aborted) {
          onAbort();
        }
      });
    },
  };
  const result = await runBashCommand(
    opts({ command: "sleep 30", timeoutMs: 200, profile: cancellableProfile }),
  );
  assert.equal(result.timedOut, true);
  assert.equal(killSignalAborted, true);
  assert.equal(delayedSigkillApplied, false);
  assert.ok(result.wallTimeMs < 500, `wallTime=${String(result.wallTimeMs)}`);
});

test("流式 onDelta 收到 stdout 文本", { skip }, async () => {
  const deltas: string[] = [];
  await runBashCommand(
    opts({
      command: "echo streaming",
      onDelta: (stream, delta) => stream === "stdout" && deltas.push(delta),
    }),
  );
  assert.ok(deltas.join("").includes("streaming"));
});

test("工作目录不存在返回 spawnError", { skip }, async () => {
  const result = await runBashCommand(
    opts({ command: "echo hi", workdir: join(tmpdir(), "roll-bash-nope-xyz") }),
  );
  assert.ok(result.spawnError !== undefined);
});
