import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions, SpawnSyncReturns } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  buildPowerShellEncodedCommand,
  resolveShellProfile,
  type ShellProfileResolutionDeps,
} from "./profile.ts";

const TRUSTED_PWSH_DIR = "C:\\Trusted PowerShell";
const TRUSTED_PWSH = `${TRUSTED_PWSH_DIR}\\pwsh.exe`;
const SYSTEM_ROOT = "C:\\Windows";
const TASKKILL = `${SYSTEM_ROOT}\\System32\\taskkill.exe`;
const DEFAULT_WINDOWS_ENV = { Path: TRUSTED_PWSH_DIR, SystemRoot: SYSTEM_ROOT } as const;

type WindowsResolutionOverrides = Omit<Partial<ShellProfileResolutionDeps>, "platform">;

function resolveWindowsProfile(overrides: WindowsResolutionOverrides = {}) {
  return resolveShellProfile({
    env: DEFAULT_WINDOWS_ENV,
    fileExists: (path) => path.toLowerCase() === TRUSTED_PWSH.toLowerCase(),
    ...overrides,
    platform: "win32",
  });
}

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

function fakeChild(
  emitEvent: (child: EventEmitter) => void,
  onKill: () => void = () => {},
  onUnref: () => void = () => {},
): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { kill(): boolean; unref(): void };
  child.kill = () => {
    onKill();
    return true;
  };
  child.unref = onUnref;
  queueMicrotask(() => emitEvent(child));
  return child as unknown as ChildProcess;
}

test("resolveShellProfile 在非 Windows 返回 POSIX profile", () => {
  const result = resolveShellProfile({
    platform: "darwin",
    env: { SHELL: "/bin/zsh" },
    fileExists: (path) => path === "/bin/zsh" || path === "/bin/sh",
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  assert.equal(result.profile.id, "posix");
  assert.equal(result.profile.toolName, "bash");
  assert.equal(result.profile.supportsSessionExec, true);
  assert.equal(result.profile.supportsSafeCommandClassification, true);
  assert.equal(result.profile.waitForTreeKillAfterRootExit, false);
  const spec = result.profile.buildSpawn("echo hi", "/tmp", {});
  assert.equal(spec.file, "/bin/zsh");
  assert.deepEqual(spec.args, ["-c", "echo hi"]);
  const safeSpec = result.profile.buildSpawn("echo hi", "/tmp", { SHELL: "/bin/sh" });
  assert.equal(safeSpec.file, "/bin/sh");
});

test("resolveShellProfile 在 win32 + pwsh 7 返回 PowerShell profile", () => {
  const result = resolveWindowsProfile({
    spawnSync: spawnSyncWith("7\n"),
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  assert.equal(result.profile.id, "powershell");
  assert.equal(result.profile.toolName, "powershell");
  assert.equal(result.profile.supportsSessionExec, true);
  assert.equal(result.profile.supportsSafeCommandClassification, false);
  assert.equal(result.profile.waitForTreeKillAfterRootExit, true);
  assert.equal(result.profile.classify("Get-ChildItem", "/repo"), "unknown");

  const spec = result.profile.buildSpawn("Write-Output hi", "C:\\repo", {});
  assert.equal(spec.file, TRUSTED_PWSH);
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

  const result = resolveWindowsProfile({
    env: { ProgramFiles: "C:\\Program Files", SystemRoot: SYSTEM_ROOT },
    fileExists: (path) => path === standardInstall,
    spawnSync: fakeSpawnSync,
  });

  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  assert.deepEqual(calls, [standardInstall]);
  assert.equal(result.profile.buildSpawn("Write-Output hi", "C:\\repo", {}).file, standardInstall);
});

test("PowerShell 解析跳过 cwd/相对 PATH，并按 Windows 语义去重绝对候选", () => {
  const calls: string[] = [];
  const result = resolveWindowsProfile({
    env: {
      PATH: `.;relative-bin;\\root-relative;\\\\tools;"${TRUSTED_PWSH_DIR}";c:\\trusted powershell;;`,
      systemroot: SYSTEM_ROOT,
    },
    fileExists: () => true,
    spawnSync: ((file: string) => {
      calls.push(file);
      return spawnSyncResult("7\n");
    }) as typeof import("node:child_process").spawnSync,
  });

  assert.equal(result.supported, true);
  assert.deepEqual(calls, [TRUSTED_PWSH]);
  if (!result.supported) {
    return;
  }
  assert.equal(result.profile.buildSpawn("Write-Output hi", "C:\\repo", {}).file, TRUSTED_PWSH);
});

test("resolveShellProfile 在 win32 缺少 pwsh 或版本低于 7 时不支持", () => {
  const missing = resolveWindowsProfile({
    spawnSync: spawnSyncWith("", new Error("ENOENT")),
  });
  assert.deepEqual(missing, { supported: false, reason: "pwsh-not-found" });

  const old = resolveWindowsProfile({
    spawnSync: spawnSyncWith("5\n"),
  });
  assert.deepEqual(old, { supported: false, reason: "pwsh-version-unsupported" });
});

test("resolveShellProfile 拒绝非零退出的 PowerShell 版本探测", () => {
  const result = resolveWindowsProfile({
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

  const result = resolveWindowsProfile({
    spawnSync: fakeSpawnSync,
    now: () => 0,
  });

  assert.equal(result.supported, true);
  assert.equal(calls[0]?.file, TRUSTED_PWSH);
  assert.deepEqual(calls[0]?.args, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$PSVersionTable.PSVersion.Major",
  ]);
  assert.deepEqual(calls[0]?.options, { encoding: "utf8", timeout: 5_000, windowsHide: true });
});

test("PowerShell 多候选版本探测共享单一总 deadline", () => {
  const first = "C:\\First\\pwsh.exe";
  const second = "C:\\Second\\pwsh.exe";
  const calls: string[] = [];
  let now = 0;
  const result = resolveWindowsProfile({
    env: { Path: "C:\\First;C:\\Second", SystemRoot: SYSTEM_ROOT },
    fileExists: (path) => path === first || path === second,
    now: () => now,
    spawnSync: ((file: string) => {
      calls.push(file);
      now = 5_000;
      return spawnSyncResult("", new Error("ETIMEDOUT"));
    }) as typeof import("node:child_process").spawnSync,
  });

  assert.deepEqual(result, { supported: false, reason: "pwsh-not-found" });
  assert.deepEqual(calls, [first]);
});

test("PowerShell 首候选成功后不触碰后续候选", () => {
  const first = "C:\\First\\pwsh.exe";
  const second = "C:\\Second\\pwsh.exe";
  const existsCalls: string[] = [];
  const probeCalls: string[] = [];
  const result = resolveWindowsProfile({
    env: { Path: "C:\\First;C:\\Second", SystemRoot: SYSTEM_ROOT },
    fileExists: (path) => {
      existsCalls.push(path);
      return true;
    },
    spawnSync: ((file: string) => {
      probeCalls.push(file);
      return spawnSyncResult("7\n");
    }) as typeof import("node:child_process").spawnSync,
  });

  assert.equal(result.supported, true);
  assert.deepEqual(existsCalls, [first]);
  assert.deepEqual(probeCalls, [first]);
  assert.ok(!existsCalls.includes(second));
});

test("PowerShell fileExists 返回后若总 deadline 已耗尽，不探测或触碰后续候选", () => {
  const first = "C:\\First\\pwsh.exe";
  const existsCalls: string[] = [];
  let probeCalls = 0;
  let now = 0;
  const result = resolveWindowsProfile({
    env: { Path: "C:\\First;C:\\Second", SystemRoot: SYSTEM_ROOT },
    fileExists: (path) => {
      existsCalls.push(path);
      now = 5_000;
      return true;
    },
    now: () => now,
    spawnSync: (() => {
      probeCalls += 1;
      return spawnSyncResult("7\n");
    }) as unknown as typeof import("node:child_process").spawnSync,
  });

  assert.deepEqual(result, { supported: false, reason: "pwsh-not-found" });
  assert.deepEqual(existsCalls, [first]);
  assert.equal(probeCalls, 0);
});

test("PowerShell profile 对过长 EncodedCommand 返回清晰错误", () => {
  const result = resolveWindowsProfile({
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
  const result = resolveWindowsProfile({
    spawnSync: spawnSyncWith("7\n"),
    spawn: ((file, args, options) => {
      calls.push({
        file,
        args: args ?? [],
        options: options ?? {},
      });
      return fakeChild((child) => {
        closed = true;
        child.emit("close", 0, null);
      });
    }) as typeof import("node:child_process").spawn,
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  await result.profile.killTree(1234, "terminate");
  assert.equal(closed, true);
  assert.equal(calls[0]?.file, TASKKILL);
  assert.deepEqual(calls[0]?.args, ["/PID", "1234", "/T", "/F"]);
  assert.equal(calls[0]?.options.windowsHide, true);
});

test("PowerShell profile killTree 在缺少绝对 SystemRoot 时拒绝", async () => {
  let spawnCalls = 0;
  const result = resolveWindowsProfile({
    env: { Path: TRUSTED_PWSH_DIR },
    spawnSync: spawnSyncWith("7\n"),
    spawn: (() => {
      spawnCalls += 1;
      return fakeChild(() => {});
    }) as typeof import("node:child_process").spawn,
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  await assert.rejects(result.profile.killTree(1234, "terminate"), /SystemRoot/u);
  assert.equal(spawnCalls, 0);
});

test("PowerShell profile killTree 传播 taskkill ENOENT", async () => {
  const result = resolveWindowsProfile({
    spawnSync: spawnSyncWith("7\n"),
    spawn: (() =>
      fakeChild((child) =>
        child.emit("error", new Error("spawn taskkill.exe ENOENT")),
      )) as typeof import("node:child_process").spawn,
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  await assert.rejects(result.profile.killTree(1234, "terminate"), /ENOENT/u);
});

test("PowerShell profile killTree 传播 taskkill 非零退出", async () => {
  const result = resolveWindowsProfile({
    spawnSync: spawnSyncWith("7\n"),
    spawn: (() =>
      fakeChild((child) =>
        child.emit("close", 5, null),
      )) as typeof import("node:child_process").spawn,
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  await assert.rejects(result.profile.killTree(1234, "terminate"), /exitCode=5/u);
});

test("PowerShell profile killTree 将 taskkill 128（进程已退出）视为清理完成", async () => {
  const result = resolveWindowsProfile({
    spawnSync: spawnSyncWith("7\n"),
    spawn: (() =>
      fakeChild((child) =>
        child.emit("close", 128, null),
      )) as typeof import("node:child_process").spawn,
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  await result.profile.killTree(1234, "terminate");
});

test("PowerShell profile killTree 对永不 close 的 taskkill 使用独立 deadline", async () => {
  let taskkillKilled = 0;
  let taskkillUnrefed = 0;
  const result = resolveWindowsProfile({
    spawnSync: spawnSyncWith("7\n"),
    taskkillTimeoutMs: 10,
    spawn: (() =>
      fakeChild(
        () => {},
        () => {
          taskkillKilled += 1;
        },
        () => {
          taskkillUnrefed += 1;
        },
      )) as typeof import("node:child_process").spawn,
  });
  assert.equal(result.supported, true);
  if (!result.supported) {
    return;
  }
  await assert.rejects(result.profile.killTree(1234, "terminate"), /10ms 内未结束/u);
  assert.equal(taskkillKilled, 1);
  assert.equal(taskkillUnrefed, 1);
});
