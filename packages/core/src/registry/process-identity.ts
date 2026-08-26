import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";

declare const PROCESS_START_TOKEN_BRAND: unique symbol;

/** Opaque digest of an OS-reported process creation identity. */
export type ProcessStartToken = string & {
  readonly [PROCESS_START_TOKEN_BRAND]: true;
};

export const PROCESS_START_TOKEN_VERIFICATION_STATUSES = {
  MATCH: "match",
  MISMATCH: "mismatch",
  UNAVAILABLE: "unavailable",
} as const;

export const PROCESS_START_TOKEN_VERIFICATION_REASONS = {
  TOKEN_MATCH: "token-match",
  TOKEN_MISMATCH: "token-mismatch",
  PROCESS_NOT_FOUND: "process-not-found",
  INVALID_PID: "invalid-pid",
  INVALID_EXPECTED_TOKEN: "invalid-expected-token",
  IDENTITY_UNAVAILABLE: "identity-unavailable",
  LEGACY_TOKEN_UNVERIFIABLE: "legacy-token-unverifiable",
} as const;

export type ProcessStartTokenVerificationStatus =
  (typeof PROCESS_START_TOKEN_VERIFICATION_STATUSES)[keyof typeof PROCESS_START_TOKEN_VERIFICATION_STATUSES];
type ProcessStartTokenVerificationReason =
  (typeof PROCESS_START_TOKEN_VERIFICATION_REASONS)[keyof typeof PROCESS_START_TOKEN_VERIFICATION_REASONS];

export type ProcessStartTokenVerification =
  | {
      readonly status: typeof PROCESS_START_TOKEN_VERIFICATION_STATUSES.MATCH;
      readonly reason: typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MATCH;
      readonly currentProcessStartToken: ProcessStartToken;
    }
  | {
      readonly status: typeof PROCESS_START_TOKEN_VERIFICATION_STATUSES.MISMATCH;
      readonly reason:
        | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MISMATCH
        | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.PROCESS_NOT_FOUND;
      readonly currentProcessStartToken: ProcessStartToken | undefined;
    }
  | {
      readonly status: typeof PROCESS_START_TOKEN_VERIFICATION_STATUSES.UNAVAILABLE;
      readonly reason: Exclude<
        ProcessStartTokenVerificationReason,
        | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MATCH
        | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MISMATCH
        | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.PROCESS_NOT_FOUND
      >;
      readonly currentProcessStartToken: ProcessStartToken | undefined;
    };

const PROCESS_START_TOKEN_PATTERNS = {
  V1: /^pst-v1:[a-f0-9]{64}$/u,
  V2: /^pst-v2:[a-f0-9]{64}$/u,
} as const;
const PROCESS_START_TOKEN_PREFIXES = {
  V1: "pst-v1",
  V2: "pst-v2",
} as const;
type ProcessStartTokenPrefix =
  (typeof PROCESS_START_TOKEN_PREFIXES)[keyof typeof PROCESS_START_TOKEN_PREFIXES];

const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 8_000;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

export function identityCommandTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32"
    ? WINDOWS_PROCESS_IDENTITY_COMMAND_TIMEOUT_MS
    : PROCESS_IDENTITY_COMMAND_TIMEOUT_MS;
}

export function resolveTrustedWindowsPowerShellExecutables(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): readonly string[] {
  const candidates: string[] = [];
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
  if (systemRoot !== undefined && WINDOWS_DRIVE_PATH_PATTERN.test(systemRoot)) {
    candidates.push(
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
  }
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
  if (programFiles !== undefined && WINDOWS_DRIVE_PATH_PATTERN.test(programFiles)) {
    candidates.push(win32.join(programFiles, "PowerShell", "7", "pwsh.exe"));
  }
  return candidates.filter((candidate) => exists(candidate));
}

export function isProcessStartToken(value: unknown): value is ProcessStartToken {
  return (
    typeof value === "string" &&
    (PROCESS_START_TOKEN_PATTERNS.V1.test(value) || PROCESS_START_TOKEN_PATTERNS.V2.test(value))
  );
}

/**
 * Reads an OS-owned process creation value and turns it into a stable opaque token.
 *
 * Returning `undefined` is intentional: callers must fail closed instead of treating a PID as
 * identity when the platform cannot prove which process instance currently owns it.
 */
export function readProcessStartToken(pid: number): ProcessStartToken | undefined {
  if (!isValidPid(pid)) return undefined;

  const rawIdentity = readVersion2RawProcessStartIdentity(pid);
  if (rawIdentity === undefined) return undefined;

  return createProcessStartToken(PROCESS_START_TOKEN_PREFIXES.V2, rawIdentity);
}

/**
 * Verifies that `pid` still identifies the process instance represented by `expected`.
 *
 * `unavailable` deliberately differs from `mismatch`: callers may only signal or clean up
 * metadata after a proven match/mismatch, never when the OS identity cannot be established.
 */
export function verifyProcessStartToken(
  pid: number,
  expected: ProcessStartToken,
): ProcessStartTokenVerification {
  if (!isValidPid(pid)) {
    return createUnavailableVerification(
      PROCESS_START_TOKEN_VERIFICATION_REASONS.INVALID_PID,
      undefined,
    );
  }
  if (!isProcessStartToken(expected)) {
    return createUnavailableVerification(
      PROCESS_START_TOKEN_VERIFICATION_REASONS.INVALID_EXPECTED_TOKEN,
      undefined,
    );
  }

  if (expected.startsWith(`${PROCESS_START_TOKEN_PREFIXES.V2}:`)) {
    const currentProcessStartToken = readProcessStartToken(pid);
    if (currentProcessStartToken === undefined) return classifyUnreadableProcessIdentity(pid);
    return currentProcessStartToken === expected
      ? createMatchVerification(currentProcessStartToken)
      : createMismatchVerification(
          PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MISMATCH,
          currentProcessStartToken,
        );
  }

  return verifyLegacyProcessStartToken(pid, expected);
}

function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function createProcessStartToken(
  prefix: ProcessStartTokenPrefix,
  rawIdentity: string,
): ProcessStartToken | undefined {
  const token = `${prefix}:${createHash("sha256").update(rawIdentity).digest("hex")}`;
  return isProcessStartToken(token) ? token : undefined;
}

function readVersion2RawProcessStartIdentity(pid: number): string | undefined {
  switch (process.platform) {
    case "linux":
    case "android":
      return readLinuxProcessStartIdentity(pid, "v2");
    case "darwin":
      return readDarwinProcessStartIdentity(pid);
    case "win32":
      return readWindowsProcessStartIdentity(pid, "v2");
    default:
      return readPosixProcessStartIdentity(pid);
  }
}

function readLegacyRawProcessStartIdentity(pid: number): string | undefined {
  switch (process.platform) {
    case "linux":
    case "android":
      return readLinuxProcessStartIdentity(pid, "v1");
    case "darwin":
      return readLegacyDarwinProcessStartIdentity(pid);
    case "win32":
      return readWindowsProcessStartIdentity(pid, "v1");
    default:
      return readLegacyPosixProcessStartIdentity(pid);
  }
}

function readLinuxProcessStartIdentity(pid: number, version: "v1" | "v2"): string | undefined {
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
    return version === "v1"
      ? `linux:${bootId}:${startTime}`
      : `linux-v2:${bootId.toLowerCase()}:${startTime}`;
  } catch {
    return undefined;
  }
}

function readDarwinProcessStartIdentity(pid: number): string | undefined {
  const startedAt = runIdentityCommand("/bin/ps", ["-p", String(pid), "-o", "lstart="], true);
  const bootSessionId = runIdentityCommand(
    "/usr/sbin/sysctl",
    ["-n", "kern.bootsessionuuid"],
    true,
  );
  if (startedAt === undefined || bootSessionId === undefined) return undefined;

  const normalizedBootSessionId = bootSessionId.toLowerCase();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(normalizedBootSessionId)
  ) {
    return undefined;
  }
  return `darwin-v2:${normalizedBootSessionId}:${normalizeWhitespace(startedAt)}`;
}

function readLegacyDarwinProcessStartIdentity(pid: number): string | undefined {
  const startedAt = runIdentityCommand("/bin/ps", ["-p", String(pid), "-o", "lstart="], false);
  const bootTime = runIdentityCommand("/usr/sbin/sysctl", ["-n", "kern.boottime"], false);
  if (startedAt === undefined || bootTime === undefined) return undefined;
  return `darwin:${bootTime}:${startedAt}`;
}

function readWindowsProcessStartIdentity(pid: number, version: "v1" | "v2"): string | undefined {
  const script =
    `$p = Get-Process -Id ${String(pid)} -ErrorAction Stop; ` +
    "$p.StartTime.ToUniversalTime().Ticks";
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const deadline = performance.now() + identityCommandTimeoutMs("win32");
  for (const executable of resolveTrustedWindowsPowerShellExecutables()) {
    const remainingMs = Math.ceil(deadline - performance.now());
    if (remainingMs <= 0) {
      break;
    }
    const startedAt = runIdentityCommand(executable, args, true, remainingMs);
    if (startedAt !== undefined && /^\d+$/u.test(startedAt)) {
      return version === "v1" ? `win32:${startedAt}` : `win32-v2:${startedAt}`;
    }
  }
  return undefined;
}

function readPosixProcessStartIdentity(pid: number): string | undefined {
  const startedAt = runIdentityCommand("ps", ["-p", String(pid), "-o", "lstart="], true);
  return startedAt === undefined
    ? undefined
    : `${process.platform}-v2:${normalizeWhitespace(startedAt)}`;
}

function readLegacyPosixProcessStartIdentity(pid: number): string | undefined {
  const startedAt = runIdentityCommand("ps", ["-p", String(pid), "-o", "lstart="], false);
  return startedAt === undefined ? undefined : `${process.platform}:${startedAt}`;
}

function verifyLegacyProcessStartToken(
  pid: number,
  expected: ProcessStartToken,
): ProcessStartTokenVerification {
  const rawIdentity = readLegacyRawProcessStartIdentity(pid);
  if (rawIdentity === undefined) return classifyUnreadableProcessIdentity(pid);

  const currentProcessStartToken = createProcessStartToken(
    PROCESS_START_TOKEN_PREFIXES.V1,
    rawIdentity,
  );
  if (currentProcessStartToken === undefined) {
    return createUnavailableVerification(
      PROCESS_START_TOKEN_VERIFICATION_REASONS.IDENTITY_UNAVAILABLE,
      undefined,
    );
  }
  if (currentProcessStartToken === expected) {
    return createMatchVerification(currentProcessStartToken);
  }

  if (
    process.platform === "linux" ||
    process.platform === "android" ||
    process.platform === "win32"
  ) {
    return createMismatchVerification(
      PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MISMATCH,
      currentProcessStartToken,
    );
  }

  // Darwin's v1 token used timezone-sensitive `ps` output and generic POSIX has the same risk.
  // A mismatch therefore cannot prove PID reuse; only an exact legacy digest is authoritative.
  return createUnavailableVerification(
    PROCESS_START_TOKEN_VERIFICATION_REASONS.LEGACY_TOKEN_UNVERIFIABLE,
    currentProcessStartToken,
  );
}

function classifyUnreadableProcessIdentity(pid: number): ProcessStartTokenVerification {
  return readProcessLiveness(pid) === "missing"
    ? createMismatchVerification(
        PROCESS_START_TOKEN_VERIFICATION_REASONS.PROCESS_NOT_FOUND,
        undefined,
      )
    : createUnavailableVerification(
        PROCESS_START_TOKEN_VERIFICATION_REASONS.IDENTITY_UNAVAILABLE,
        undefined,
      );
}

function readProcessLiveness(pid: number): "alive" | "missing" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "ESRCH") return "missing";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function createMatchVerification(
  currentProcessStartToken: ProcessStartToken,
): ProcessStartTokenVerification {
  return {
    status: PROCESS_START_TOKEN_VERIFICATION_STATUSES.MATCH,
    reason: PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MATCH,
    currentProcessStartToken,
  };
}

function createMismatchVerification(
  reason:
    | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MISMATCH
    | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.PROCESS_NOT_FOUND,
  currentProcessStartToken: ProcessStartToken | undefined,
): ProcessStartTokenVerification {
  return {
    status: PROCESS_START_TOKEN_VERIFICATION_STATUSES.MISMATCH,
    reason,
    currentProcessStartToken,
  };
}

function createUnavailableVerification(
  reason: Extract<
    ProcessStartTokenVerificationReason,
    | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.INVALID_PID
    | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.INVALID_EXPECTED_TOKEN
    | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.IDENTITY_UNAVAILABLE
    | typeof PROCESS_START_TOKEN_VERIFICATION_REASONS.LEGACY_TOKEN_UNVERIFIABLE
  >,
  currentProcessStartToken: ProcessStartToken | undefined,
): ProcessStartTokenVerification {
  return {
    status: PROCESS_START_TOKEN_VERIFICATION_STATUSES.UNAVAILABLE,
    reason,
    currentProcessStartToken,
  };
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function runIdentityCommand(
  command: string,
  args: readonly string[],
  useCanonicalTimeZone: boolean,
  timeoutMs: number = identityCommandTimeoutMs(),
): string | undefined {
  try {
    const result = spawnSync(command, [...args], {
      encoding: "utf-8",
      env: {
        ...process.env,
        LC_ALL: "C",
        LANG: "C",
        ...(useCanonicalTimeZone ? { TZ: "UTC" } : {}),
      },
      shell: false,
      timeout: timeoutMs,
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
