import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_MANAGER_COMMANDS = ["bun", "npm", "pnpm", "yarn"] as const;

export type PackageManagerCommandName = (typeof PACKAGE_MANAGER_COMMANDS)[number];

export interface PackageManagerRunSpec {
  readonly command: PackageManagerCommandName;
  readonly args: readonly string[];
}

export interface InstallCommandSpec {
  readonly command: PackageManagerCommandName;
  readonly args: readonly ["install"];
}

export interface PackageManagerRunOptions extends Omit<ExecFileOptions, "encoding" | "shell"> {
  readonly platform?: NodeJS.Platform;
}

export interface PackageManagerRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface PackageManagerExecInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export function detectInstallCommand(projectDir: string): InstallCommandSpec | undefined {
  const packageJsonPath = resolve(projectDir, "package.json");
  if (existsSync(packageJsonPath)) {
    const packageManager = readPackageManager(packageJsonPath);
    if (packageManager) {
      return {
        command: packageManager,
        args: ["install"],
      };
    }
  }

  const lockfileEntries: ReadonlyArray<readonly [string, InstallCommandSpec["command"]]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ];

  for (const [lockfile, command] of lockfileEntries) {
    if (existsSync(resolve(projectDir, lockfile))) {
      return {
        command,
        args: ["install"],
      };
    }
  }

  return undefined;
}

export function createInstallCommand(
  command: PackageManagerCommandName = "pnpm",
): InstallCommandSpec {
  return {
    command,
    args: ["install"],
  };
}

export async function runPackageManager(
  spec: PackageManagerRunSpec,
  options: PackageManagerRunOptions = {},
): Promise<PackageManagerRunResult> {
  const { platform, ...execOptions } = options;
  const invocation = createPackageManagerExecInvocation(spec, platform ?? process.platform);

  const result = await execFileAsync(invocation.file, [...invocation.args], {
    ...execOptions,
    encoding: "utf-8",
    ...(invocation.shell ? { shell: invocation.shell } : {}),
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function createPackageManagerExecInvocation(
  spec: PackageManagerRunSpec,
  platform: NodeJS.Platform = process.platform,
): PackageManagerExecInvocation {
  if (shouldRunPackageManagerViaShell(platform)) {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", formatWindowsShellCommand(spec)],
      shell: false,
    };
  }

  return {
    file: spec.command,
    args: spec.args,
    shell: false,
  };
}

export function shouldRunPackageManagerViaShell(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

export function formatPackageManagerCommand(spec: PackageManagerRunSpec): string {
  return [spec.command, ...spec.args].map(formatCliArg).join(" ");
}

export function formatPackageManagerError(
  spec: PackageManagerRunSpec,
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const commandLine = formatPackageManagerCommand(spec);
  if (isPackageManagerNotFound(spec.command, error, platform)) {
    return [
      `未找到 ${spec.command}，无法执行 \`${commandLine}\`。`,
      platform === "win32"
        ? `请确认 ${spec.command}.cmd 位于 PATH 中；npm 全局目录通常是 C:\\Users\\<you>\\AppData\\Roaming\\npm。`
        : `请确认已安装 ${spec.command}，并且当前 shell 的 PATH 可以访问它。`,
    ].join("");
  }

  return error instanceof Error ? error.message : String(error);
}

function readPackageManager(packageJsonPath: string): InstallCommandSpec["command"] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      readonly packageManager?: unknown;
    };
    if (typeof parsed.packageManager !== "string" || parsed.packageManager.length === 0) {
      return undefined;
    }

    const [name] = parsed.packageManager.split("@", 1);
    if (!name) {
      return undefined;
    }
    return isPackageManagerCommandName(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function isPackageManagerCommandName(value: string): value is PackageManagerCommandName {
  return PACKAGE_MANAGER_COMMANDS.some((command) => command === value);
}

function formatCliArg(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

function formatWindowsShellCommand(spec: PackageManagerRunSpec): string {
  return [spec.command, ...spec.args].map(formatWindowsShellArg).join(" ");
}

function formatWindowsShellArg(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }

  if (/["\r\n]/.test(arg)) {
    throw new Error(`Unsupported Windows shell argument: ${arg}`);
  }

  return /[\s"&|<>^()%!]/.test(arg) ? `"${escapeWindowsQuotedArg(arg)}"` : arg;
}

function escapeWindowsQuotedArg(arg: string): string {
  return arg.replace(/[\^&|<>%!]/g, (char) => `^${char}`);
}

function isPackageManagerNotFound(
  command: PackageManagerCommandName,
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  const code = readErrorCode(error);
  if (code === "ENOENT") {
    return true;
  }

  if (platform !== "win32") {
    return false;
  }

  const message = readErrorMessage(error).toLowerCase();
  return (
    message.includes(`'${command}' is not recognized`) ||
    message.includes(`"${command}" is not recognized`) ||
    message.includes(`${command} is not recognized`) ||
    message.includes(`'${command}' 不是内部或外部命令`) ||
    message.includes(`"${command}" 不是内部或外部命令`) ||
    message.includes(`${command} 不是内部或外部命令`)
  );
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
