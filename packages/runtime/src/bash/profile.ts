import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 as pathWin32 } from "node:path";
import type { CommandClassification } from "../types/command-classification.ts";
import { unknownCommandClassifier } from "../types/command-classification.ts";
import { ruleBasedClassifier } from "./classifier/index.ts";
import { DEFAULT_KILL_GRACE_MS, killProcessGroup } from "./kill.ts";
import { resolveUserShell } from "./shell.ts";

export const SHELL_PROFILE_IDS = ["posix", "powershell"] as const;
export type ShellProfileId = (typeof SHELL_PROFILE_IDS)[number];

export const SHELL_TOOL_NAMES = ["bash", "powershell"] as const;
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

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
const POWERSHELL_STANDARD_INSTALL_SUBPATH = ["PowerShell", "7", "pwsh.exe"] as const;

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
    buildSpawn(command, workdir, env) {
      return {
        file: resolveUserShell({ platform: deps.platform, env: deps.env, fileExists }),
        args: ["-c", command],
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
        "过滤和预览输出时可使用 grep、sed、head、tail 等 POSIX 工具。",
      ];
    },
  };
}

function taskkill(
  pid: number | undefined,
  spawnImpl: typeof spawn,
  options: ShellKillOptions = {},
): Promise<void> {
  if (pid === undefined || options.signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", finish);
      resolve();
    };
    const child = spawnImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", finish);
    child.once("close", finish);
    options.signal?.addEventListener("abort", finish, { once: true });
  });
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

function buildPowerShellArgs(command: string): readonly string[] {
  const encoded = buildPowerShellEncodedCommand(command);
  const args = [...POWERSHELL_STATIC_ARGS, encoded];
  const estimatedChars =
    estimateCommandLineChars("pwsh", args) + POWERSHELL_COMMAND_LINE_HEADROOM_CHARS;
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

function powerShellExecutableCandidates(
  deps: ShellProfileResolutionDeps,
  fileExists: (path: string) => boolean,
): readonly string[] {
  const candidates = ["pwsh"];
  const installRoots = [
    getWindowsEnvValue(deps.env, "ProgramFiles"),
    getWindowsEnvValue(deps.env, "ProgramW6432"),
    getWindowsEnvValue(deps.env, "ProgramFiles(x86)"),
  ];
  for (const root of installRoots) {
    if (root === undefined) {
      continue;
    }
    const candidate = pathWin32.join(root, ...POWERSHELL_STANDARD_INSTALL_SUBPATH);
    if (fileExists(candidate) && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function detectPowerShellMajorVersion(
  executable: string,
  spawnSyncImpl: typeof spawnSync,
): number | undefined {
  const result = spawnSyncImpl(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
    { encoding: "utf8", timeout: POWERSHELL_VERSION_PROBE_TIMEOUT_MS, windowsHide: true },
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
  let sawUnsupportedVersion = false;
  for (const executable of powerShellExecutableCandidates(deps, fileExists)) {
    const major = detectPowerShellMajorVersion(executable, spawnSyncImpl);
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
  return {
    supported: true,
    profile: {
      id: "powershell",
      toolName: "powershell",
      supportsSessionExec: false,
      supportsSafeCommandClassification: false,
      buildSpawn(command, workdir, env) {
        return {
          file: executable.executable,
          args: buildPowerShellArgs(command),
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
        await taskkill(pid, spawnImpl, options);
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
