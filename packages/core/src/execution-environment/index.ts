import { AsyncLocalStorage } from "node:async_hooks";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface InstallationContext {
  readonly channel: "standalone" | "host" | "development" | "unknown";
  readonly packageRoot: string;
  readonly version: string;
  readonly installRoot?: string;
  readonly versionRoot?: string;
  readonly platform?: string;
}

export interface ExecutionCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

export interface ExecutionEnvironment {
  readonly mode: "bundled" | "host";
  readonly nodePath: string;
  readonly npmCliPath?: string;
  readonly npxCliPath?: string;
  readonly installation: InstallationContext;
  createEnv(base: NodeJS.ProcessEnv): Record<string, string>;
  resolveCommand(
    command: string,
    args: readonly string[],
    base: NodeJS.ProcessEnv,
  ): ExecutionCommand;
}

const scopedEnvironment = new AsyncLocalStorage<ExecutionEnvironment>();

/** Update operations can use the newly installed version without changing global process state. */
export function withExecutionEnvironment<T>(environment: ExecutionEnvironment, fn: () => T): T {
  return scopedEnvironment.run(environment, fn);
}

export function getExecutionEnvironment(): ExecutionEnvironment {
  return scopedEnvironment.getStore() ?? resolveExecutionEnvironment();
}

export function resolveExecutionEnvironment(
  options: {
    readonly packageRoot?: string;
    readonly nodePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly baseEnv?: NodeJS.ProcessEnv;
  } = {},
): ExecutionEnvironment {
  const packageRoot = realpathSync(options.packageRoot ?? resolve(import.meta.dirname, "../.."));
  const pkg = readObject(join(packageRoot, "package.json"));
  const version = typeof pkg["version"] === "string" ? pkg["version"] : "unknown";
  const platform = options.platform ?? process.platform;
  const versionRoot = dirname(packageRoot);
  const metadataPath = join(versionRoot, "distribution.json");
  const installRoot =
    basename(dirname(versionRoot)) === "versions" ? dirname(dirname(versionRoot)) : undefined;
  const isStandalone =
    pkg["rollDistribution"] !== undefined ||
    existsSync(metadataPath) ||
    (installRoot !== undefined && existsSync(join(installRoot, "installation.json")));
  let installation: InstallationContext;
  let nodePath: string;
  let npmCliPath: string | undefined;
  let npxCliPath: string | undefined;

  if (isStandalone) {
    const marker = pkg["rollDistribution"];
    if (!isObject(marker) || marker["schemaVersion"] !== 1 || marker["channel"] !== "standalone") {
      throw new Error("Invalid Roll standalone package marker; reinstall Roll.");
    }
    const metadata = readObject(metadataPath);
    const target = metadata["platform"];
    if (
      metadata["schemaVersion"] !== 1 ||
      metadata["channel"] !== "standalone" ||
      metadata["version"] !== version ||
      typeof metadata["nodeVersion"] !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(metadata["nodeVersion"]) ||
      typeof target !== "string" ||
      !/^(darwin|linux|win32)-(x64|arm64)$/.test(target) ||
      target !== `${platform}-${process.arch}` ||
      pkg["name"] !== "@roll-agent/core" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
      (installRoot !== undefined && basename(versionRoot) !== version)
    ) {
      throw new Error(
        "Invalid or incompatible Roll standalone distribution metadata; reinstall Roll.",
      );
    }
    const runtimeRoot = join(versionRoot, "runtime");
    nodePath = checkedBundledFile(
      versionRoot,
      join(runtimeRoot, platform === "win32" ? "node.exe" : "bin/node"),
    );
    if (platform !== "win32") accessSync(nodePath, constants.X_OK);
    const npmRoot = join(
      runtimeRoot,
      platform === "win32" ? "node_modules/npm" : "lib/node_modules/npm",
    );
    npmCliPath = checkedBundledFile(versionRoot, join(npmRoot, "bin/npm-cli.js"));
    npxCliPath = checkedBundledFile(versionRoot, join(npmRoot, "bin/npx-cli.js"));
    for (const tool of ["npm", "npx"]) {
      const launcher = checkedBundledFile(
        versionRoot,
        join(runtimeRoot, platform === "win32" ? `${tool}.cmd` : `bin/${tool}`),
      );
      if (platform !== "win32") accessSync(launcher, constants.X_OK);
    }
    installation = {
      channel: "standalone",
      packageRoot,
      version,
      versionRoot,
      platform: target,
      ...(installRoot ? { installRoot } : {}),
    };
  } else {
    nodePath = realpathSync(options.nodePath ?? process.execPath);
    const npmRoot = findHostNpm(nodePath, options.baseEnv ?? process.env, platform);
    npmCliPath = npmRoot ? join(npmRoot, "bin/npm-cli.js") : undefined;
    npxCliPath =
      npmRoot && existsSync(join(npmRoot, "bin/npx-cli.js"))
        ? join(npmRoot, "bin/npx-cli.js")
        : undefined;
    installation = {
      channel: existsSync(join(packageRoot, "src/cli/index.ts"))
        ? "development"
        : pkg["name"] === "@roll-agent/core"
          ? "host"
          : "unknown",
      packageRoot,
      version,
    };
  }

  const createEnv = (base: NodeJS.ProcessEnv): Record<string, string> => {
    const env = stringEnv(base);
    const pathKey =
      platform === "win32"
        ? (Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH")
        : "PATH";
    const previous = env[pathKey];
    // Windows environment keys are case insensitive. Avoid leaving two competing PATH entries.
    if (platform === "win32") {
      for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    }
    env["PATH"] = [dirname(nodePath), previous]
      .filter(Boolean)
      .join(platform === "win32" ? ";" : ":");
    return env;
  };
  return {
    mode: isStandalone ? "bundled" : "host",
    nodePath,
    ...(npmCliPath ? { npmCliPath } : {}),
    ...(npxCliPath ? { npxCliPath } : {}),
    installation,
    createEnv,
    resolveCommand(command, args, base) {
      if (command === "node" || (platform === "win32" && command === "node.exe")) {
        return { command: nodePath, args, env: createEnv(base) };
      }
      const npm = command === "npm" || (platform === "win32" && command === "npm.cmd");
      const npx = command === "npx" || (platform === "win32" && command === "npx.cmd");
      if (npm || npx) {
        const cliPath = npm ? npmCliPath : npxCliPath;
        if (!cliPath) {
          throw new Error(
            `Roll execution environment cannot locate ${npm ? "npm" : "npx"}; install npm with the host Node runtime.`,
          );
        }
        return { command: nodePath, args: [cliPath, ...args], env: createEnv(base) };
      }
      // External interpreters and explicit paths keep their declared environment and identity.
      return { command, args, env: stringEnv(base) };
    },
  };
}

function stringEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function checkedBundledFile(root: string, path: string): string {
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  if (
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel) ||
    !statSync(actual).isFile()
  ) {
    throw new Error(
      "Roll private runtime escapes its distribution or is not a file; reinstall Roll.",
    );
  }
  return actual;
}

function findHostNpm(
  nodePath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const candidates = [
    join(dirname(nodePath), "node_modules/npm"),
    resolve(dirname(nodePath), "../lib/node_modules/npm"),
  ];
  const path = Object.entries(env).find(([key]) =>
    platform === "win32" ? key.toLowerCase() === "path" : key === "PATH",
  )?.[1];
  for (const bin of (path ?? "").split(platform === "win32" ? ";" : ":")) {
    if (!bin || !isAbsolute(bin)) continue;
    try {
      const npmPath = realpathSync(join(bin, platform === "win32" ? "npm.cmd" : "npm"));
      candidates.push(resolve(dirname(npmPath), ".."), join(bin, "node_modules/npm"));
    } catch {
      /* An absent PATH entry is not a usable npm installation. */
    }
  }
  for (const candidate of candidates) {
    try {
      if (
        readObject(join(candidate, "package.json"))["name"] === "npm" &&
        existsSync(join(candidate, "bin/npm-cli.js"))
      ) {
        return realpathSync(candidate);
      }
    } catch {
      /* Try the next installed npm package, never execute a shim to discover it. */
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(parsed)) throw new Error(`Invalid Roll installation metadata: ${path}`);
  return parsed;
}
