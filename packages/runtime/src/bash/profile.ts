import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 as pathWin32 } from "node:path";
import { performance } from "node:perf_hooks";
import type { CommandClassification } from "../types/command-classification.ts";
import { unknownCommandClassifier } from "../types/command-classification.ts";
import { ruleBasedClassifier } from "./classifier/index.ts";
import { DEFAULT_KILL_GRACE_MS, killProcessGroup } from "./kill.ts";
import { resolveUserShell } from "./shell.ts";

export const SHELL_PROFILE_IDS = ["posix", "powershell"] as const;
export type ShellProfileId = (typeof SHELL_PROFILE_IDS)[number];

export const SHELL_TOOL_NAMES = ["bash", "powershell"] as const;
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

export const POSIX_PIPEFAIL_GUARD = "( set -o pipefail ) 2>/dev/null && set -o pipefail; ";

export function wrapPosixCommand(command: string): string {
  return `${POSIX_PIPEFAIL_GUARD}${command}`;
}

export interface ShellSpawnSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

export interface ShellKillOptions {
  readonly signal?: AbortSignal;
}

export interface ShellProfile {
  readonly id: ShellProfileId;
  readonly toolName: ShellToolName;
  readonly supportsSessionExec: boolean;
  readonly supportsSafeCommandClassification: boolean;
  readonly waitForTreeKillAfterRootExit?: boolean;
  buildSpawn(command: string, workdir: string, env: NodeJS.ProcessEnv): ShellSpawnSpec;
  classify(command: string, workdir: string): CommandClassification;
  killTree(
    pid: number | undefined,
    intent: "interrupt" | "terminate",
    options?: ShellKillOptions,
  ): Promise<void>;
  systemPromptHints(): readonly string[];
}

export interface ShellProfileResolutionDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fileExists?: (path: string) => boolean;
  readonly spawnSync?: typeof spawnSync;
  readonly spawn?: typeof spawn;
  readonly now?: () => number;
  readonly taskkillTimeoutMs?: number;
}

export type ShellProfileResolutionResult =
  | { readonly supported: true; readonly profile: ShellProfile }
  | { readonly supported: false; readonly reason: "pwsh-not-found" | "pwsh-version-unsupported" };

type PowerShellExecutableResolution =
  | { readonly supported: true; readonly executable: string }
  | Extract<ShellProfileResolutionResult, { readonly supported: false }>;

const POWERSHELL_STATIC_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;
const WINDOWS_COMMAND_LINE_MAX_CHARS = 32_767;
const POWERSHELL_COMMAND_LINE_HEADROOM_CHARS = 1_024;
const POWERSHELL_VERSION_PROBE_TIMEOUT_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 2_000;
const TASKKILL_PROCESS_NOT_FOUND_EXIT_CODE = 128;
const POWERSHELL_STANDARD_INSTALL_SUBPATH = ["PowerShell", "7", "pwsh.exe"] as const;
const TASKKILL_SYSTEM_SUBPATH = ["System32", "taskkill.exe"] as const;

function waitForGrace(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createPosixShellProfile(deps: ShellProfileResolutionDeps): ShellProfile {
  const fileExists = deps.fileExists ?? existsSync;
  return {
    id: "posix",
    toolName: "bash",
    supportsSessionExec: true,
    supportsSafeCommandClassification: true,
    waitForTreeKillAfterRootExit: false,
    buildSpawn(command, workdir, env) {
      return {
        file: resolveUserShell({ platform: deps.platform, env, fileExists }),
        args: ["-c", wrapPosixCommand(command)],
        options: {
          cwd: workdir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        },
      };
    },
    classify(command, workdir) {
      return ruleBasedClassifier.classify(command, workdir);
    },
    async killTree(pid, intent, options = {}) {
      if (options.signal?.aborted) {
        return;
      }
      if (intent === "interrupt") {
        killProcessGroup(pid, "SIGINT");
        return;
      }
      killProcessGroup(pid, "SIGTERM");
      if (await waitForGrace(DEFAULT_KILL_GRACE_MS, options.signal)) {
        killProcessGroup(pid, "SIGKILL");
      }
    },
    systemPromptHints() {
      return [
        "当前 shell 后端是 POSIX shell；优先使用 macOS/Linux 常见命令语法。",
        "管道已启用 pipefail：任一阶段失败整条管道即失败，退出码如实反映，不要依赖「最后一个命令」的退出码。",
        "仅为控制输出量时请用 roll__bash 的 max_output_chars 参数或 roll__read_file / roll__grep 等工具，不要自接 head/tail 管道；需要过滤时仍可用 grep 等工具，但退出码反映整条管道。",
      ];
    },
  };
}

function taskkill(
  pid: number | undefined,
  executable: string | undefined,
  spawnImpl: typeof spawn,
  timeoutMs: number,
  options: ShellKillOptions = {},
): Promise<void> {
  if (pid === undefined || options.signal?.aborted) {
    return Promise.resolve();
  }
  if (executable === undefined) {
    return Promise.reject(
      new Error("无法从绝对 SystemRoot 路径解析 taskkill.exe，不能安全清理进程树"),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ReturnType<typeof spawnImpl>;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = (): void => {
      try {
        child.kill();
      } catch {
        // 原命令已经退出时，取消 taskkill 只是清理动作。
      }
      try {
        child.unref();
      } catch {
        // stdio=ignore；unref 失败不应覆盖原命令已经退出的取消语义。
      }
      finish();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // timeout 错误本身会传播给调用方，kill taskkill 失败不覆盖主因。
      }
      try {
        child.unref();
      } catch {
        // timeout 错误仍会传播；unref 仅用于避免 helper 自身继续拖住 Node。
      }
      finish(new Error(`taskkill.exe 在 ${String(timeoutMs)}ms 内未结束`));
    }, timeoutMs);
    try {
      child = spawnImpl(executable, ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      finish(new Error(`无法启动 taskkill.exe: ${errorMessage(error)}`, { cause: error }));
      return;
    }
    child.once("error", (error) => {
      finish(new Error(`无法启动 taskkill.exe: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (code === 0 || code === TASKKILL_PROCESS_NOT_FOUND_EXIT_CODE) {
        finish();
        return;
      }
      const detail = code === null ? `signal=${signal ?? "unknown"}` : `exitCode=${String(code)}`;
      finish(new Error(`taskkill.exe 执行失败: ${detail}`));
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildPowerShellEncodedCommand(command: string): string {
  const wrapper = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "$ErrorActionPreference = 'Stop'",
    "try {",
    command,
    "  if (Test-Path variable:LASTEXITCODE) { exit $LASTEXITCODE }",
    "} catch {",
    "  [Console]::Error.WriteLine([string]$_)",
    "  exit 1",
    "}",
  ].join("\n");
  return Buffer.from(wrapper, "utf16le").toString("base64");
}

function estimateCommandLineChars(file: string, args: readonly string[]): number {
  return [file, ...args].reduce((total, part) => total + part.length + 1, 0);
}

function buildPowerShellArgs(command: string, executable: string): readonly string[] {
  const encoded = buildPowerShellEncodedCommand(command);
  const args = [...POWERSHELL_STATIC_ARGS, encoded];
  const estimatedChars =
    estimateCommandLineChars(executable, args) + POWERSHELL_COMMAND_LINE_HEADROOM_CHARS;
  if (estimatedChars > WINDOWS_COMMAND_LINE_MAX_CHARS) {
    throw new Error(
      `PowerShell 命令过长：编码后命令行约 ${String(estimatedChars)} 字符，超过 Windows CreateProcess 上限 ${String(WINDOWS_COMMAND_LINE_MAX_CHARS)}；请拆分命令或改为执行脚本文件。`,
    );
  }
  return args;
}

function getWindowsEnvValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const normalizedKey = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(env)) {
    if (candidateKey.toLowerCase() === normalizedKey && value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function unwrapWindowsPathEntry(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).trim() : trimmed;
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  return pathWin32.isAbsolute(value) && pathWin32.parse(value).root.length > 1;
}

function powerShellExecutableCandidates(deps: ShellProfileResolutionDeps): readonly string[] {
  const candidates: string[] = [];
  const normalizedCandidates = new Set<string>();
  const addCandidate = (candidate: string): void => {
    if (!isFullyQualifiedWindowsPath(candidate)) {
      return;
    }
    const normalized = pathWin32.normalize(candidate).toLowerCase();
    if (normalizedCandidates.has(normalized)) {
      return;
    }
    normalizedCandidates.add(normalized);
    candidates.push(pathWin32.normalize(candidate));
  };

  const pathValue = getWindowsEnvValue(deps.env, "Path");
  for (const rawEntry of pathValue?.split(pathWin32.delimiter) ?? []) {
    const entry = unwrapWindowsPathEntry(rawEntry);
    if (!isFullyQualifiedWindowsPath(entry)) {
      continue;
    }
    addCandidate(pathWin32.join(entry, "pwsh.exe"));
  }

  const installRoots = [
    getWindowsEnvValue(deps.env, "ProgramFiles"),
    getWindowsEnvValue(deps.env, "ProgramW6432"),
    getWindowsEnvValue(deps.env, "ProgramFiles(x86)"),
  ];
  for (const rawRoot of installRoots) {
    if (rawRoot === undefined) {
      continue;
    }
    const root = unwrapWindowsPathEntry(rawRoot);
    if (!isFullyQualifiedWindowsPath(root)) {
      continue;
    }
    addCandidate(pathWin32.join(root, ...POWERSHELL_STANDARD_INSTALL_SUBPATH));
  }
  return candidates;
}

function resolveTaskkillExecutable(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const rawSystemRoot = getWindowsEnvValue(env, "SystemRoot");
  if (rawSystemRoot === undefined) {
    return undefined;
  }
  const systemRoot = unwrapWindowsPathEntry(rawSystemRoot);
  if (!isFullyQualifiedWindowsPath(systemRoot)) {
    return undefined;
  }
  return pathWin32.join(systemRoot, ...TASKKILL_SYSTEM_SUBPATH);
}

function detectPowerShellMajorVersion(
  executable: string,
  spawnSyncImpl: typeof spawnSync,
  timeoutMs: number,
): number | undefined {
  const result = spawnSyncImpl(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const output = `${result.stdout ?? ""}`.trim();
  const major = Number.parseInt(output, 10);
  return Number.isFinite(major) ? major : undefined;
}

function resolvePowerShellExecutable(
  deps: ShellProfileResolutionDeps,
  spawnSyncImpl: typeof spawnSync,
): PowerShellExecutableResolution {
  const fileExists = deps.fileExists ?? existsSync;
  const now = deps.now ?? (() => performance.now());
  const deadline = now() + POWERSHELL_VERSION_PROBE_TIMEOUT_MS;
  let sawUnsupportedVersion = false;
  for (const executable of powerShellExecutableCandidates(deps)) {
    if (deadline - now() <= 0) {
      break;
    }
    if (!fileExists(executable)) {
      continue;
    }
    const remainingProbeMs = Math.ceil(deadline - now());
    if (remainingProbeMs <= 0) {
      break;
    }
    const major = detectPowerShellMajorVersion(executable, spawnSyncImpl, remainingProbeMs);
    if (major === undefined) {
      continue;
    }
    if (major >= 7) {
      return { supported: true, executable };
    }
    sawUnsupportedVersion = true;
  }
  return {
    supported: false,
    reason: sawUnsupportedVersion ? "pwsh-version-unsupported" : "pwsh-not-found",
  };
}

function createPowerShellProfile(deps: ShellProfileResolutionDeps): ShellProfileResolutionResult {
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const executable = resolvePowerShellExecutable(deps, spawnSyncImpl);
  if (!executable.supported) {
    return executable;
  }
  const spawnImpl = deps.spawn ?? spawn;
  const taskkillExecutable = resolveTaskkillExecutable(deps.env);
  const taskkillTimeoutMs = deps.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS;
  return {
    supported: true,
    profile: {
      id: "powershell",
      toolName: "powershell",
      supportsSessionExec: true,
      supportsSafeCommandClassification: false,
      waitForTreeKillAfterRootExit: true,
      buildSpawn(command, workdir, env) {
        return {
          file: executable.executable,
          args: buildPowerShellArgs(command, executable.executable),
          options: {
            cwd: workdir,
            detached: false,
            stdio: ["ignore", "pipe", "pipe"],
            env,
            windowsHide: true,
          },
        };
      },
      classify(command, workdir) {
        return unknownCommandClassifier.classify(command, workdir);
      },
      async killTree(pid, _intent, options = {}) {
        await taskkill(pid, taskkillExecutable, spawnImpl, taskkillTimeoutMs, options);
      },
      systemPromptHints() {
        return [
          "当前 shell 后端是 PowerShell 7；请使用 PowerShell 语法，例如 Get-ChildItem、Get-Content、Select-String。",
          "过滤和预览输出时优先使用 Select-String、Select-Object -First、Get-Content -TotalCount。",
        ];
      },
    },
  };
}

export function resolveShellProfile(
  deps: ShellProfileResolutionDeps,
): ShellProfileResolutionResult {
  if (deps.platform === "win32") {
    return createPowerShellProfile(deps);
  }
  return { supported: true, profile: createPosixShellProfile(deps) };
}
