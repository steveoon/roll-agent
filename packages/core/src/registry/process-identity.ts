import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

declare const PROCESS_START_TOKEN_BRAND: unique symbol;

/** Opaque digest of an OS-reported process creation identity. */
export type ProcessStartToken = string & {
  readonly [PROCESS_START_TOKEN_BRAND]: true;
};

const PROCESS_START_TOKEN_PATTERN = /^pst-v1:[a-f0-9]{64}$/u;
const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 2_000;

export function isProcessStartToken(value: unknown): value is ProcessStartToken {
  return typeof value === "string" && PROCESS_START_TOKEN_PATTERN.test(value);
}

/**
 * Reads an OS-owned process creation value and turns it into a stable opaque token.
 *
 * Returning `undefined` is intentional: callers must fail closed instead of treating a PID as
 * identity when the platform cannot prove which process instance currently owns it.
 */
export function readProcessStartToken(pid: number): ProcessStartToken | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;

  const rawIdentity = readRawProcessStartIdentity(pid);
  if (rawIdentity === undefined) return undefined;

  const token = `pst-v1:${createHash("sha256").update(rawIdentity).digest("hex")}`;
  return isProcessStartToken(token) ? token : undefined;
}

function readRawProcessStartIdentity(pid: number): string | undefined {
  switch (process.platform) {
    case "linux":
    case "android":
      return readLinuxProcessStartIdentity(pid);
    case "darwin":
      return readDarwinProcessStartIdentity(pid);
    case "win32":
      return readWindowsProcessStartIdentity(pid);
    default:
      return readPosixProcessStartIdentity(pid);
  }
}

function readLinuxProcessStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;

    // `/proc/<pid>/stat` fields after the command begin at field 3 (state). Field 22 is starttime.
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u);
    const startTime = fields[19];
    if (startTime === undefined || !/^\d+$/u.test(startTime)) return undefined;

    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    if (bootId.length === 0) return undefined;
    return `linux:${bootId}:${startTime}`;
  } catch {
    return undefined;
  }
}

function readDarwinProcessStartIdentity(pid: number): string | undefined {
  const startedAt = runIdentityCommand("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
  const bootTime = runIdentityCommand("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
  if (startedAt === undefined || bootTime === undefined) return undefined;
  return `darwin:${bootTime}:${startedAt}`;
}

function readWindowsProcessStartIdentity(pid: number): string | undefined {
  const script =
    `$p = Get-Process -Id ${String(pid)} -ErrorAction Stop; ` +
    "$p.StartTime.ToUniversalTime().Ticks";
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const startedAt =
    runIdentityCommand("powershell.exe", args) ?? runIdentityCommand("pwsh.exe", args);
  if (startedAt === undefined || !/^\d+$/u.test(startedAt)) return undefined;
  return `win32:${startedAt}`;
}

function readPosixProcessStartIdentity(pid: number): string | undefined {
  const startedAt = runIdentityCommand("ps", ["-p", String(pid), "-o", "lstart="]);
  return startedAt === undefined ? undefined : `${process.platform}:${startedAt}`;
}

function runIdentityCommand(command: string, args: readonly string[]): string | undefined {
  try {
    const result = spawnSync(command, [...args], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      shell: false,
      timeout: PROCESS_IDENTITY_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    const stdout = result.stdout.trim();
    return result.status === 0 && result.error === undefined && stdout.length > 0
      ? stdout
      : undefined;
  } catch {
    return undefined;
  }
}
