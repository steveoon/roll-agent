import { isAbsolute, resolve } from "node:path";

export interface BundledRollInvocation {
  readonly command: string;
  readonly cliEntrypoint: string;
  readonly runtimeArgs: readonly string[];
  readonly companionArgs: readonly string[];
  readonly execArgv: readonly string[];
}

/**
 * Uses the Node executable and CLI entrypoint that launched the Companion. Signed installers bundle
 * both paths, so neither the daemon nor the Runtime child resolves `roll` or `node` through PATH.
 */
export function createBundledRollInvocation(
  options: {
    readonly command?: string;
    readonly cliEntrypoint?: string;
    readonly execArgv?: readonly string[];
  } = {},
): BundledRollInvocation {
  const commandInput = options.command ?? process.execPath;
  const entrypointInput = options.cliEntrypoint ?? process.argv[1];
  if (entrypointInput === undefined || entrypointInput.trim().length === 0) {
    throw new Error("Unable to locate the bundled Roll CLI entrypoint");
  }
  const command = isAbsolute(commandInput) ? commandInput : resolve(commandInput);
  const cliEntrypoint = isAbsolute(entrypointInput) ? entrypointInput : resolve(entrypointInput);
  const safeExecArgv = (options.execArgv ?? process.execArgv).filter(isSafeRuntimeExecArgument);
  return {
    command,
    cliEntrypoint,
    execArgv: safeExecArgv,
    runtimeArgs: [...safeExecArgv, cliEntrypoint, "runtime", "serve", "--stdio"],
    companionArgs: [...safeExecArgv, cliEntrypoint, "companion", "run", "--foreground"],
  };
}

function isSafeRuntimeExecArgument(value: string): boolean {
  return (
    value === "--experimental-strip-types" ||
    value === "--experimental-sqlite" ||
    value === "--disable-warning=ExperimentalWarning" ||
    value === "--no-warnings"
  );
}
