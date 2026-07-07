export const DEFAULT_KILL_GRACE_MS = 150;

export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* ESRCH: 进程组已消失 */
  }
}

export function escalateKillGroup(
  pid: number | undefined,
  graceMs: number = DEFAULT_KILL_GRACE_MS,
): NodeJS.Timeout {
  killProcessGroup(pid, "SIGTERM");
  return setTimeout(() => killProcessGroup(pid, "SIGKILL"), graceMs);
}
