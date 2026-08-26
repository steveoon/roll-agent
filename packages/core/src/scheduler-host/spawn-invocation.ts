import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { ClaimedInvocation } from "@roll-agent/runtime";
import type { BundledRollInvocation } from "../companion-host/invocation.ts";
import {
  KILL_PROCESS_TREE_OUTCOMES,
  killProcessTree,
  type KillProcessTreeOutcome,
} from "./executor-liveness.ts";
import { SCHEDULE_DATA_DIR_ENV, SCHEDULE_TOKEN_ENV } from "./paths.ts";

export type SpawnedInvocationSignal = "SIGTERM" | "SIGKILL";

export interface SpawnedInvocation {
  readonly exited: Promise<number | null>;
  kill(signal: SpawnedInvocationSignal): KillProcessTreeOutcome | void;
}

export type InvocationSpawner = (claim: ClaimedInvocation) => SpawnedInvocation;

export interface CreateInvocationSpawnerOptions {
  readonly invocation: BundledRollInvocation;
  readonly dataDir: string;
  readonly logPath: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function createInvocationSpawner(
  options: CreateInvocationSpawnerOptions,
): InvocationSpawner {
  return (claim) => {
    const logFd = openSync(options.logPath, "a", 0o600);
    let closed = false;
    const closeLog = () => {
      if (!closed) {
        closed = true;
        closeSync(logFd);
      }
    };
    const child = spawn(
      options.invocation.command,
      [
        ...options.invocation.execArgv,
        options.invocation.cliEntrypoint,
        "schedule",
        "exec",
        "--invocation",
        claim.invocation.id,
      ],
      {
        cwd: claim.schedule.cwd,
        env: {
          ...(options.env ?? process.env),
          [SCHEDULE_TOKEN_ENV]: claim.ownershipToken,
          [SCHEDULE_DATA_DIR_ENV]: options.dataDir,
        },
        stdio: ["ignore", "ignore", logFd],
        windowsHide: true,
        detached: true,
      },
    );
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        closeLog();
        resolve(code);
      });
      child.once("error", () => {
        closeLog();
        resolve(null);
      });
    });
    return {
      exited,
      kill: (signal: SpawnedInvocationSignal) =>
        child.pid === undefined
          ? KILL_PROCESS_TREE_OUTCOMES.failed
          : killProcessTree(child.pid, signal),
    };
  };
}
