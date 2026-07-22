import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CURRENT_CLI_ENV = "ROLL_CURRENT_CLI";
const INSPECT_ARG_PATTERN = /^--inspect/u;
const NODE_PATH_ARGUMENTS = [
  "--require",
  "-r",
  "--import",
  "--loader",
  "--experimental-loader",
] as const;

export interface CurrentCliShim {
  readonly path: string;
  dispose(): void;
}

export interface InstallCurrentCliShimOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly executable?: string;
  readonly execArgv?: readonly string[];
  readonly entryPath?: string;
  readonly launchCwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly tempRoot?: string;
}

interface EnvShimEntry {
  readonly directory: string;
  readonly path: string;
  active: boolean;
}

interface EnvShimState {
  readonly pathKey: string;
  readonly basePath: string | undefined;
  readonly baseCurrentCli: string | undefined;
  readonly entries: EnvShimEntry[];
}

const envShimStates = new WeakMap<NodeJS.ProcessEnv, EnvShimState>();

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function windowsQuote(value: string): string {
  const escapedPercent = value.replaceAll("%", "%%");
  const escapedQuotes = escapedPercent.replaceAll('"', '\\"');
  return `"${escapedQuotes}"`;
}

function absoluteLaunchSpecifier(value: string, launchCwd: string): string {
  return /^\.{1,2}[\\/]/u.test(value) ? resolve(launchCwd, value) : value;
}

function forwardedExecArgv(execArgv: readonly string[], launchCwd: string): readonly string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (argument === undefined || INSPECT_ARG_PATTERN.test(argument)) {
      continue;
    }
    const pathArgument = NODE_PATH_ARGUMENTS.find((candidate) => candidate === argument);
    if (pathArgument !== undefined) {
      forwarded.push(argument);
      const value = execArgv[index + 1];
      if (value !== undefined) {
        forwarded.push(absoluteLaunchSpecifier(value, launchCwd));
        index += 1;
      }
      continue;
    }
    const inlinePathArgument = NODE_PATH_ARGUMENTS.find((candidate) =>
      argument.startsWith(`${candidate}=`),
    );
    if (inlinePathArgument !== undefined) {
      const value = argument.slice(inlinePathArgument.length + 1);
      forwarded.push(`${inlinePathArgument}=${absoluteLaunchSpecifier(value, launchCwd)}`);
      continue;
    }
    forwarded.push(argument);
  }
  return forwarded;
}

function resolvePathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return "PATH";
  }
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function renderPosixShim(command: readonly string[]): string {
  return `#!/bin/sh\nexec ${command.map(posixQuote).join(" ")} "$@"\n`;
}

function renderWindowsShim(command: readonly string[]): string {
  return [
    "@echo off",
    `${command.map(windowsQuote).join(" ")} %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

export function installCurrentCliShim(options: InstallCurrentCliShimOptions): CurrentCliShim {
  const executable = options.executable ?? process.execPath;
  const entryPath = options.entryPath ?? process.argv[1];
  if (!entryPath) {
    throw new Error("无法确定当前 Roll CLI 入口");
  }

  const platform = options.platform ?? process.platform;
  const env = options.env;
  const separator = platform === "win32" ? ";" : ":";
  let directory: string | undefined;
  let shimPath: string;
  try {
    directory = mkdtempSync(join(options.tempRoot ?? tmpdir(), "roll-current-cli-"));
    chmodSync(directory, 0o700);
    shimPath = join(directory, platform === "win32" ? "roll.cmd" : "roll");
    const command = [
      executable,
      ...forwardedExecArgv(
        options.execArgv ?? process.execArgv,
        options.launchCwd ?? process.cwd(),
      ),
      entryPath,
    ];
    const content = platform === "win32" ? renderWindowsShim(command) : renderPosixShim(command);
    writeFileSync(shimPath, content, { encoding: "utf8", mode: 0o700 });
  } catch (error) {
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }

  const pathKey = resolvePathKey(env, platform);
  const existingState = envShimStates.get(env);
  const state =
    existingState ??
    ({
      pathKey,
      basePath: env[pathKey],
      baseCurrentCli: env[CURRENT_CLI_ENV],
      entries: [],
    } satisfies EnvShimState);
  if (existingState === undefined) {
    envShimStates.set(env, state);
  }
  const entry: EnvShimEntry = { directory, path: shimPath, active: true };
  state.entries.push(entry);
  const currentPath = env[pathKey];
  env[pathKey] = currentPath ? `${directory}${separator}${currentPath}` : directory;
  env[CURRENT_CLI_ENV] = shimPath;

  const removeDirectory = (): void => {
    rmSync(directory, { recursive: true, force: true });
  };
  process.once("exit", removeDirectory);
  let disposed = false;

  return {
    path: shimPath,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      process.removeListener("exit", removeDirectory);
      entry.active = false;
      const activeEntries = state.entries.filter((candidate) => candidate.active);
      if (activeEntries.length === 0) {
        if (state.basePath === undefined) {
          delete env[state.pathKey];
        } else {
          env[state.pathKey] = state.basePath;
        }
        if (state.baseCurrentCli === undefined) {
          delete env[CURRENT_CLI_ENV];
        } else {
          env[CURRENT_CLI_ENV] = state.baseCurrentCli;
        }
        envShimStates.delete(env);
      } else {
        const pathValue = env[state.pathKey];
        if (pathValue !== undefined) {
          env[state.pathKey] = pathValue
            .split(separator)
            .filter((candidate) => candidate !== directory)
            .join(separator);
        }
        if (state.entries.some((candidate) => candidate.path === env[CURRENT_CLI_ENV])) {
          env[CURRENT_CLI_ENV] = activeEntries.at(-1)?.path;
        }
      }
      removeDirectory();
    },
  };
}
