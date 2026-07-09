import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBashCommand, type RunBashOptions } from "./exec.ts";
import { resolveShellProfile, type ShellProfile } from "./profile.ts";

const skip = process.platform !== "win32";
const MB = 1_048_576;

function resolvePowerShellProfile(): ShellProfile {
  const result = resolveShellProfile({ platform: "win32", env: process.env });
  if (!result.supported) {
    assert.fail(`PowerShell profile unsupported: ${result.reason}`);
  }
  return result.profile;
}

function opts(overrides: Partial<RunBashOptions> & { command: string }): RunBashOptions {
  return {
    workdir: tmpdir(),
    timeoutMs: 15_000,
    maxCaptureBytes: MB,
    profile: resolvePowerShellProfile(),
    ...overrides,
  };
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

test("PowerShell one-shot: Write-Output 输出 stdout", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "Write-Output 'hello'" }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.text.trim(), "hello");
});

test("PowerShell one-shot: UTF-8 中文输出", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "Write-Output '中文输出'" }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.text.trim(), "中文输出");
});

test("PowerShell one-shot: 非零退出码透传", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "exit 7" }));
  assert.equal(result.exitCode, 7);
});

test("PowerShell one-shot: cmdlet 非终止错误不会伪装成成功", { skip }, async () => {
  const missingFile = join(tmpdir(), `roll-agent-missing-${String(process.pid)}.txt`);
  const result = await runBashCommand(
    opts({ command: `Get-Content -LiteralPath ${psQuote(missingFile)}` }),
  );
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.ok(result.stderr.text.length > 0);
});

test("PowerShell one-shot: native LASTEXITCODE 不会被后续输出吞掉", { skip }, async () => {
  const result = await runBashCommand(
    opts({ command: "cmd /c exit 7; Write-Output 'after-native-failure'" }),
  );
  assert.equal(result.exitCode, 7);
  assert.match(result.stdout.text, /after-native-failure/u);
});

test("PowerShell one-shot: timeout 调 taskkill 并归一为 124", { skip }, async () => {
  const result = await runBashCommand(opts({ command: "Start-Sleep -Seconds 30", timeoutMs: 500 }));
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.ok(result.wallTimeMs < 5_000, `wallTime=${String(result.wallTimeMs)}`);
});

test("PowerShell one-shot: AbortSignal 可快速终止长任务", { skip }, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const result = await runBashCommand(
      opts({ command: "Start-Sleep -Seconds 30", abortSignal: controller.signal }),
    );
    assert.equal(result.timedOut, false);
    assert.ok(result.wallTimeMs < 5_000, `wallTime=${String(result.wallTimeMs)}`);
  } finally {
    clearTimeout(timer);
  }
});

test("PowerShell one-shot: 过长 EncodedCommand 在 spawn 前返回清晰错误", { skip }, async () => {
  const result = await runBashCommand(opts({ command: `Write-Output '${"x".repeat(25_000)}'` }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.match(result.spawnError ?? "", /PowerShell 命令过长/u);
});
