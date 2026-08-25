import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { EXECUTOR_LIVENESS } from "@roll-agent/runtime";
import type { ExecutorIdentity, ExecutorLiveness } from "@roll-agent/runtime";
import {
  PROCESS_START_TOKEN_VERIFICATION_STATUSES,
  isProcessStartToken,
  readProcessStartToken,
  verifyProcessStartToken,
} from "../registry/process-identity.ts";

const PROCESS_STATE_TIMEOUT_MS = 2_000;

const LIVENESS_BY_VERIFICATION = {
  [PROCESS_START_TOKEN_VERIFICATION_STATUSES.MATCH]: EXECUTOR_LIVENESS.alive,
  [PROCESS_START_TOKEN_VERIFICATION_STATUSES.MISMATCH]: EXECUTOR_LIVENESS.dead,
  [PROCESS_START_TOKEN_VERIFICATION_STATUSES.UNAVAILABLE]: EXECUTOR_LIVENESS.unknown,
} as const satisfies Record<
  (typeof PROCESS_START_TOKEN_VERIFICATION_STATUSES)[keyof typeof PROCESS_START_TOKEN_VERIFICATION_STATUSES],
  ExecutorLiveness
>;

function readProcessState(pid: number): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }
  if (process.platform === "linux" || process.platform === "android") {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
      const commandEnd = stat.lastIndexOf(")");
      return commandEnd < 0
        ? undefined
        : stat
            .slice(commandEnd + 1)
            .trim()
            .charAt(0);
    } catch {
      return undefined;
    }
  }
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf-8",
      timeout: PROCESS_STATE_TIMEOUT_MS,
      windowsHide: true,
    });
    const state = result.stdout.trim();
    return result.status === 0 && state.length > 0 ? state.charAt(0) : undefined;
  } catch {
    return undefined;
  }
}

function isZombie(pid: number): boolean {
  return readProcessState(pid) === "Z";
}

export function probeExecutorLiveness(executor: ExecutorIdentity): ExecutorLiveness {
  if (!isProcessStartToken(executor.startToken)) {
    return EXECUTOR_LIVENESS.unknown;
  }
  const liveness =
    LIVENESS_BY_VERIFICATION[verifyProcessStartToken(executor.pid, executor.startToken).status];
  if (liveness === EXECUTOR_LIVENESS.alive && isZombie(executor.pid)) {
    return EXECUTOR_LIVENESS.dead;
  }
  return liveness;
}

export function currentExecutorIdentity(pid: number = process.pid): ExecutorIdentity | undefined {
  const startToken = readProcessStartToken(pid);
  return startToken === undefined ? undefined : { pid, startToken };
}

export function terminateExecutor(
  executor: ExecutorIdentity,
  signal: NodeJS.Signals = "SIGKILL",
): boolean {
  if (probeExecutorLiveness(executor) !== EXECUTOR_LIVENESS.alive) {
    return false;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-executor.pid, signal);
      return true;
    } catch {
      // not a process-group leader; fall back to the single pid
    }
  }
  try {
    process.kill(executor.pid, signal);
    return true;
  } catch {
    return false;
  }
}
