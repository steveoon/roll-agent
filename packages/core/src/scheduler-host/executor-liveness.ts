import { EXECUTOR_LIVENESS } from "@roll-agent/runtime";
import type { ExecutorIdentity, ExecutorLiveness } from "@roll-agent/runtime";
import {
  PROCESS_START_TOKEN_VERIFICATION_STATUSES,
  isProcessStartToken,
  readProcessStartToken,
  verifyProcessStartToken,
} from "../registry/process-identity.ts";

const LIVENESS_BY_VERIFICATION = {
  [PROCESS_START_TOKEN_VERIFICATION_STATUSES.MATCH]: EXECUTOR_LIVENESS.alive,
  [PROCESS_START_TOKEN_VERIFICATION_STATUSES.MISMATCH]: EXECUTOR_LIVENESS.dead,
  [PROCESS_START_TOKEN_VERIFICATION_STATUSES.UNAVAILABLE]: EXECUTOR_LIVENESS.unknown,
} as const satisfies Record<
  (typeof PROCESS_START_TOKEN_VERIFICATION_STATUSES)[keyof typeof PROCESS_START_TOKEN_VERIFICATION_STATUSES],
  ExecutorLiveness
>;

export function probeExecutorLiveness(executor: ExecutorIdentity): ExecutorLiveness {
  if (!isProcessStartToken(executor.startToken)) {
    return EXECUTOR_LIVENESS.unknown;
  }
  return LIVENESS_BY_VERIFICATION[
    verifyProcessStartToken(executor.pid, executor.startToken).status
  ];
}

export function currentExecutorIdentity(pid: number = process.pid): ExecutorIdentity | undefined {
  const startToken = readProcessStartToken(pid);
  return startToken === undefined ? undefined : { pid, startToken };
}
