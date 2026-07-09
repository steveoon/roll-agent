import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions, SpawnSyncReturns } from "node:child_process";
import { buildPowerShellEncodedCommand, resolveShellProfile } from "./profile.ts";

function spawnSyncResult(
  stdout: string,
  error?: Error,
  status: number | null = error ? null : 0,
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
    ...(error ? { error } : {}),
  } as SpawnSyncReturns<string>;
}

function spawnSyncWith(
  stdout: string,
  error?: Error,
  status: number | null = error ? null : 0,
): typeof import("node:child_process").spawnSync {
  return (() =>
    spawnSyncResult(
      stdout,
      error,
      status,
    )) as unknown as typeof import("node:child_process").spawnSync;
}

function fakeChild(close: () => void): ChildProcess {
  const child = {
    once(event: string, listener: (...args: unknown[]) => void) {
      if (event === "close") {
        queueMicrotask(() => {
          listener(0, null);
          close();
        });
      }
      return child;
    },
  };
  return child as unknown as ChildProcess;
}

test("resolveShellProfile 在非 Windows 返回 POSIX profile", () => {
  const result = resolveShellProfile({
    platform: "darwin",
    env: { SHELL: "/bin/zsh" },
    fileExists: (path) => path === "/bin/zsh",
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  assert.equal(result.profile.id, "posix");
  assert.equal(result.profile.toolName, "bash");
  assert.equal(result.profile.supportsSessionExec, true);
  assert.equal(result.profile.supportsSafeCommandClassification, true);
  const spec = result.profile.buildSpawn("echo hi", "/tmp", {});
  assert.equal(spec.file, "/bin/zsh");
  assert.deepEqual(spec.args, ["-c", "echo hi"]);
});

test("resolveShellProfile 在 win32 + pwsh 7 返回 PowerShell profile", () => {
  const result = resolveShellProfile({
    platform: "win32",
    env: {},
    spawnSync: spawnSyncWith("7\n"),
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  assert.equal(result.profile.id, "powershell");
  assert.equal(result.profile.toolName, "powershell");
  assert.equal(result.profile.supportsSessionExec, false);
  assert.equal(result.profile.supportsSafeCommandClassification, false);
  assert.equal(result.profile.classify("Get-ChildItem", "/repo"), "unknown");

  const spec = result.profile.buildSpawn("Write-Output hi", "C:\\repo", {});
  assert.equal(spec.file, "pwsh");
  assert.deepEqual(spec.args.slice(0, 6), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
  ]);
  const encoded = spec.args.at(-1);
  assert.ok(encoded);
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.ok(decoded.includes("[Console]::OutputEncoding"));
  assert.ok(decoded.includes("$OutputEncoding"));
  assert.ok(decoded.includes("$ErrorActionPreference = 'Stop'"));
  assert.ok(decoded.includes("Test-Path variable:LASTEXITCODE"));
  assert.ok(decoded.includes("Write-Output hi"));
  assert.equal(spec.options.windowsHide, true);
  assert.equal(spec.options.detached, false);
});

test("resolveShellProfile 在 PATH 未命中时尝试 Program Files PowerShell 7", () => {
  const standardInstall = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const calls: string[] = [];
  const fakeSpawnSync = ((file: string) => {
    calls.push(file);
    if (file === standardInstall) {
      return spawnSyncResult("7\n");
    }
    return spawnSyncResult("", new Error("ENOENT"));
  }) as typeof import("node:child_process").spawnSync;

  const result = resolveShellProfile({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    fileExists: (path) => path === standardInstall,
    spawnSync: fakeSpawnSync,
  });

  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  assert.deepEqual(calls, ["pwsh", standardInstall]);
  assert.equal(result.profile.buildSpawn("Write-Output hi", "C:\\repo", {}).file, standardInstall);
});

test("resolveShellProfile 在 win32 缺少 pwsh 或版本低于 7 时不支持", () => {
  const missing = resolveShellProfile({
    platform: "win32",
    env: {},
    spawnSync: spawnSyncWith("", new Error("ENOENT")),
  });
  assert.deepEqual(missing, { supported: false, reason: "pwsh-not-found" });

  const old = resolveShellProfile({
    platform: "win32",
    env: {},
    spawnSync: spawnSyncWith("5\n"),
  });
  assert.deepEqual(old, { supported: false, reason: "pwsh-version-unsupported" });
});

test("resolveShellProfile 拒绝非零退出的 PowerShell 版本探测", () => {
  const result = resolveShellProfile({
    platform: "win32",
    env: {},
    spawnSync: spawnSyncWith("7\n", undefined, 1),
  });
  assert.deepEqual(result, { supported: false, reason: "pwsh-not-found" });
});

test("buildPowerShellEncodedCommand 使用 UTF-16LE base64 并保留明文命令", () => {
  const encoded = buildPowerShellEncodedCommand("Write-Output '中文'");
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.ok(decoded.includes("Write-Output '中文'"));
  assert.ok(decoded.includes("$ErrorActionPreference = 'Stop'"));
  assert.ok(decoded.includes("Test-Path variable:LASTEXITCODE"));
  assert.ok(decoded.includes("catch"));
  assert.ok(decoded.includes("exit 1"));
});

test("PowerShell 版本探测带 timeout，避免 spawnSync 无限挂起", () => {
  const calls: Array<{
    readonly file: string;
    readonly args: readonly string[] | undefined;
    readonly options: object | undefined;
  }> = [];
  const fakeSpawnSync = ((file: string, args?: readonly string[], options?: object) => {
    calls.push({ file, args, options });
    return {
      pid: 1,
      output: [null, "7\n", ""],
      stdout: "7\n",
      stderr: "",
      status: 0,
      signal: null,
    } as SpawnSyncReturns<string>;
  }) as typeof import("node:child_process").spawnSync;

  const result = resolveShellProfile({
    platform: "win32",
    env: {},
    spawnSync: fakeSpawnSync,
  });

  assert.equal(result.supported, true);
  assert.equal(calls[0]?.file, "pwsh");
  assert.deepEqual(calls[0]?.args, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$PSVersionTable.PSVersion.Major",
  ]);
  assert.deepEqual(calls[0]?.options, { encoding: "utf8", timeout: 5_000, windowsHide: true });
});

test("PowerShell profile 对过长 EncodedCommand 返回清晰错误", () => {
  const result = resolveShellProfile({
    platform: "win32",
    env: {},
    spawnSync: spawnSyncWith("7\n"),
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  assert.throws(
    () => result.profile.buildSpawn(`Write-Output '${"x".repeat(25_000)}'`, "C:\\repo", {}),
    /PowerShell 命令过长/u,
  );
});

test("PowerShell profile killTree 调用 taskkill /T /F", async () => {
  const calls: Array<{
    readonly file: string;
    readonly args: readonly string[];
    readonly options: SpawnOptions;
  }> = [];
  let closed = false;
  const result = resolveShellProfile({
    platform: "win32",
    env: {},
    spawnSync: spawnSyncWith("7\n"),
    spawn: ((file, args, options) => {
      calls.push({
        file,
        args: args ?? [],
        options: options ?? {},
      });
      return fakeChild(() => {
        closed = true;
      });
    }) as typeof import("node:child_process").spawn,
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  await result.profile.killTree(1234, "terminate");
  assert.equal(closed, true);
  assert.equal(calls[0]?.file, "taskkill");
  assert.deepEqual(calls[0]?.args, ["/PID", "1234", "/T", "/F"]);
  assert.equal(calls[0]?.options.windowsHide, true);
});
