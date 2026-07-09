import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBashCommand, type RunBashOptions } from "./exec.ts";
import { escalateKillGroup, killProcessGroup } from "./kill.ts";
import type { ShellProfile } from "./profile.ts";

const skip = process.platform === "win32";
const MB = 1_048_576;

const profile: ShellProfile = {
  id: "posix",
  toolName: "bash",
  supportsSessionExec: true,
  supportsSafeCommandClassification: true,
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

test("echo 成功返回 stdout 与 exit 0", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "echo hi" }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.text.trim(), "hi");
  assert.ok(result.wallTimeMs >= 0);
});

test("非零退出码透传", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "exit 7" }));
  assert.equal(result.exitCode, 7);
});

test("超时杀进程组并归一 124，快速返回", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "sleep 30", timeoutMs: 200 }));
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
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
  assert.ok(result.wallTimeMs < 3_000, `wallTime=${String(result.wallTimeMs)}`);
});

test("进程退出时取消 profile 的延迟补刀", { skip }, async () => {
  let killSignalAborted = false;
  const cancellableProfile: ShellProfile = {
    ...profile,
    killTree: async (pid, intent, options) => {
      if (intent === "interrupt") {
        killProcessGroup(pid, "SIGINT");
        return;
      }
      killProcessGroup(pid, "SIGTERM");
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            killSignalAborted = true;
            resolve();
          },
          { once: true },
        );
      });
    },
  };
  const result = await runBashCommand(
    opts({ command: "sleep 30", timeoutMs: 200, profile: cancellableProfile }),
  );
  assert.equal(result.timedOut, true);
  assert.equal(killSignalAborted, true);
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
