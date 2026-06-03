import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 默认 stdout/stderr 缓冲上限（64MB）。
 *
 * Node `execFile` 默认 maxBuffer 仅 1MB，弱网下 npm 会打印大量 retry / 进度日志，
 * 一旦超出 1MB 会抛 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`——即使安装其实已成功，
 * 也会被误判为失败。这里显式放大上限来消除这个隐藏失败源。
 */
const PACKAGE_MANAGER_MAX_BUFFER = 64 * 1024 * 1024;

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
    maxBuffer: PACKAGE_MANAGER_MAX_BUFFER,
    ...execOptions,
    encoding: "utf-8",
    ...(invocation.shell ? { shell: invocation.shell } : {}),
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export interface PackageManagerRetryPolicy {
  /** 整体命令的最大尝试次数（>=1）。 */
  readonly attempts: number;
  /** 每次重试前的等待时长（毫秒），长度不足时复用最后一项。 */
  readonly backoffMs?: readonly number[];
  /** 判定某次失败是否值得重试，默认仅对网络/超时类错误重试。 */
  readonly isRetryable?: (error: unknown) => boolean;
  /** 每次重试前回调（用于日志）。 */
  readonly onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在 {@link runPackageManager} 之上叠加“仅对网络/超时类错误重试”的能力。
 *
 * 与 npm 自身的 `--fetch-retries`（针对单个 tarball 抓取）互补：
 * 这里重试的是整条命令，覆盖 registry 完全不可达、超时被 kill 等硬失败场景。
 */
export async function runPackageManagerWithRetry(
  spec: PackageManagerRunSpec,
  options: PackageManagerRunOptions = {},
  policy: PackageManagerRetryPolicy,
): Promise<PackageManagerRunResult> {
  const attempts = Math.max(1, policy.attempts);
  const isRetryable = policy.isRetryable ?? isRetryablePackageManagerError;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runPackageManager(spec, options);
    } catch (error) {
      lastError = error;
      const hasNext = attempt < attempts;
      if (!hasNext || !isRetryable(error)) {
        throw error;
      }
      const backoff = policy.backoffMs ?? [];
      const delayMs = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 2000;
      policy.onRetry?.({ attempt, error, delayMs });
      await delay(delayMs);
    }
  }

  throw lastError;
}

/**
 * 构造一个 npm 安装重试策略。
 *
 * `fetchRetries` 同时用于 npm 的 `--fetch-retries` 与 roll 层整体重试：
 * 整体尝试次数 = `min(fetchRetries + 1, 3)`，避免弱网下重试时间无界增长。
 */
export function buildNpmRetryPolicy(fetchRetries: number): PackageManagerRetryPolicy {
  const attempts = Math.min(Math.max(fetchRetries, 0) + 1, 3);
  return {
    attempts,
    backoffMs: [2000, 5000].slice(0, Math.max(attempts - 1, 0)),
    isRetryable: isRetryablePackageManagerError,
  };
}

export function createPackageManagerExecInvocation(
  spec: PackageManagerRunSpec,
  platform: NodeJS.Platform = process.platform,
): PackageManagerExecInvocation {
  if (shouldRunPackageManagerViaShell(platform)) {
    // 同时覆盖 win-x64 / win-arm64：两者都通过 cmd.exe 包裹来规避 Node 直接
    // spawn `npm.cmd` / `pnpm.cmd` 的 ENOENT 问题。优先用 ComSpec，兼容定制 shell 路径。
    return {
      file: resolveWindowsShell(),
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

function resolveWindowsShell(): string {
  const comSpec = process.env["ComSpec"] ?? process.env["COMSPEC"];
  return comSpec && comSpec.trim().length > 0 ? comSpec : "cmd.exe";
}

export interface NpmNetworkOptions {
  /** 显式 registry（镜像源）。未提供时沿用 npm 默认源。 */
  readonly registry?: string;
  /** 透传给 npm 的 `--fetch-retries`。 */
  readonly fetchRetries?: number;
  /** 是否附加 `--prefer-offline`。 */
  readonly preferOffline?: boolean;
}

/**
 * 构造 `npm install` 的网络韧性参数。
 *
 * 始终附加 `--no-audit --no-fund`（减少额外网络请求、提速），并按需附加
 * `--registry` / `--fetch-retries` / `--prefer-offline`。
 */
export function npmInstallNetworkArgs(options: NpmNetworkOptions = {}): string[] {
  const args: string[] = ["--no-audit", "--no-fund"];
  if (options.registry) {
    args.push(`--registry=${options.registry}`);
  }
  if (options.fetchRetries !== undefined) {
    args.push(`--fetch-retries=${String(options.fetchRetries)}`);
  }
  if (options.preferOffline) {
    args.push("--prefer-offline");
  }
  return args;
}

/** 构造 `npm view` 的网络参数（只需 registry + fetch-retries）。 */
export function npmViewNetworkArgs(options: NpmNetworkOptions = {}): string[] {
  const args: string[] = [];
  if (options.registry) {
    args.push(`--registry=${options.registry}`);
  }
  if (options.fetchRetries !== undefined) {
    args.push(`--fetch-retries=${String(options.fetchRetries)}`);
  }
  return args;
}

export function formatPackageManagerCommand(spec: PackageManagerRunSpec): string {
  return [spec.command, ...spec.args].map(formatCliArg).join(" ");
}

const NETWORK_HINT =
  "疑似网络或 npm 源不稳定。可在 roll.config.yaml 配置 `install.registry` 指向可用镜像" +
  "（如 https://registry.npmmirror.com），或检查 VPN / 代理后重试。";

const NETWORK_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ERR_SOCKET_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const NETWORK_ERROR_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bnetwork\b/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /fetch failed/i,
  /getaddrinfo/i,
  /tunneling socket could not be established/i,
  /request to .+ failed/i,
  /npm\s+(?:error|ERR!)\s+code\s+E429/i,
  /\bregistry\b.*\b(timeout|timed out|unreachable)\b/i,
  /\bproxy\b/i,
];

/** 进程因 `timeout` 选项被 kill（execFile 超时会 SIGTERM 子进程）。 */
function isProcessTimeoutKill(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const killed = "killed" in error && error.killed === true;
  const signal = "signal" in error && error.signal === "SIGTERM";
  const noExitCode = !("code" in error) || error.code === null || error.code === undefined;
  return killed && signal && noExitCode;
}

/** 判断错误是否疑似网络/镜像源问题。 */
export function isLikelyNetworkError(error: unknown): boolean {
  const code = readErrorCode(error);
  if (code && NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  const message = readErrorMessage(error);
  return NETWORK_ERROR_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/** 网络/超时类错误才值得对整条命令重试。 */
export function isRetryablePackageManagerError(error: unknown): boolean {
  return isProcessTimeoutKill(error) || isLikelyNetworkError(error);
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

  if (isProcessTimeoutKill(error)) {
    return `\`${commandLine}\` 执行超时被终止。${NETWORK_HINT}`;
  }

  if (isLikelyNetworkError(error)) {
    const detail = error instanceof Error ? error.message : String(error);
    return `\`${commandLine}\` 执行失败：${detail}\n${NETWORK_HINT}`;
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
