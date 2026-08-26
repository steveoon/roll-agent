import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isProcessStartToken,
  PROCESS_START_TOKEN_VERIFICATION_REASONS,
  PROCESS_START_TOKEN_VERIFICATION_STATUSES,
  readProcessStartToken,
  identityCommandTimeoutMs,
  resolveTrustedWindowsPowerShellExecutables,
  verifyProcessStartToken,
} from "./process-identity.ts";
import type { ProcessStartToken } from "./process-identity.ts";

test("recognizes legacy and current process start token versions", () => {
  assert.equal(isProcessStartToken(`pst-v1:${"0".repeat(64)}`), true);
  assert.equal(isProcessStartToken(`pst-v2:${"a".repeat(64)}`), true);
  assert.equal(isProcessStartToken(`pst-v3:${"a".repeat(64)}`), false);
  assert.equal(isProcessStartToken(`pst-v2:${"A".repeat(64)}`), false);
  assert.equal(isProcessStartToken("pst-v2:not-a-digest"), false);
  assert.equal(isProcessStartToken(undefined), false);
});

test("writes pst-v2 tokens and rejects invalid PIDs", () => {
  assert.equal(readProcessStartToken(0), undefined);
  assert.equal(readProcessStartToken(-1), undefined);
  assert.equal(readProcessStartToken(1.5), undefined);
  assert.equal(readProcessStartToken(Number.MAX_SAFE_INTEGER + 1), undefined);

  const token = readProcessStartToken(process.pid);
  assert.ok(token);
  assert.match(token, /^pst-v2:[a-f0-9]{64}$/u);
});

test("verifies a matching process and proves a live-token mismatch", () => {
  const currentToken = readProcessStartToken(process.pid);
  assert.ok(currentToken);

  const unavailable = verifyProcessStartToken(0, currentToken);
  assert.deepEqual(unavailable, {
    status: PROCESS_START_TOKEN_VERIFICATION_STATUSES.UNAVAILABLE,
    reason: PROCESS_START_TOKEN_VERIFICATION_REASONS.INVALID_PID,
    currentProcessStartToken: undefined,
  });

  const match = verifyProcessStartToken(process.pid, currentToken);
  assert.deepEqual(match, {
    status: PROCESS_START_TOKEN_VERIFICATION_STATUSES.MATCH,
    reason: PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MATCH,
    currentProcessStartToken: currentToken,
  });

  const differentToken = requireProcessStartToken(
    `pst-v2:${currentToken.endsWith("0".repeat(64)) ? "1".repeat(64) : "0".repeat(64)}`,
  );
  const mismatch = verifyProcessStartToken(process.pid, differentToken);
  assert.equal(mismatch.status, PROCESS_START_TOKEN_VERIFICATION_STATUSES.MISMATCH);
  assert.equal(mismatch.reason, PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MISMATCH);
  assert.equal(mismatch.currentProcessStartToken, currentToken);
});

test("returns mismatch after the represented PID has exited", () => {
  const currentToken = readProcessStartToken(process.pid);
  assert.ok(currentToken);

  const child = spawnSync(process.execPath, ["-e", ""], {
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.pid > 0);

  const verification = verifyProcessStartToken(child.pid, currentToken);
  assert.equal(verification.status, PROCESS_START_TOKEN_VERIFICATION_STATUSES.MISMATCH);
  assert.ok(
    verification.reason === PROCESS_START_TOKEN_VERIFICATION_REASONS.PROCESS_NOT_FOUND ||
      verification.reason === PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MISMATCH,
  );
});

test("pst-v2 identity is stable across caller time zones", () => {
  const originalTimeZone = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utcToken = readProcessStartToken(process.pid);
    assert.ok(utcToken);

    process.env.TZ = "Pacific/Honolulu";
    const honoluluToken = readProcessStartToken(process.pid);
    assert.ok(honoluluToken);

    assert.equal(honoluluToken, utcToken);
  } finally {
    restoreTimeZone(originalTimeZone);
  }
});

test("verifies an exact legacy token for the current process", () => {
  const legacyToken = readLegacyProcessStartToken(process.pid);
  assert.ok(legacyToken);

  const verification = verifyProcessStartToken(process.pid, legacyToken);
  assert.equal(verification.status, PROCESS_START_TOKEN_VERIFICATION_STATUSES.MATCH);
  assert.equal(verification.reason, PROCESS_START_TOKEN_VERIFICATION_REASONS.TOKEN_MATCH);
  assert.equal(verification.currentProcessStartToken, legacyToken);
});

test(
  "treats a timezone-induced Darwin pst-v1 mismatch as unavailable",
  { skip: process.platform !== "darwin" },
  () => {
    const originalTimeZone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const legacyToken = readLegacyProcessStartToken(process.pid);
      assert.ok(legacyToken);

      process.env.TZ = "Pacific/Honolulu";
      const verification = verifyProcessStartToken(process.pid, legacyToken);
      assert.equal(verification.status, PROCESS_START_TOKEN_VERIFICATION_STATUSES.UNAVAILABLE);
      assert.equal(
        verification.reason,
        PROCESS_START_TOKEN_VERIFICATION_REASONS.LEGACY_TOKEN_UNVERIFIABLE,
      );
    } finally {
      restoreTimeZone(originalTimeZone);
    }
  },
);

function requireProcessStartToken(value: string): ProcessStartToken {
  assert.ok(isProcessStartToken(value));
  return value;
}

function readLegacyProcessStartToken(pid: number): ProcessStartToken | undefined {
  const rawIdentity = readLegacyRawProcessStartIdentity(pid);
  if (rawIdentity === undefined) return undefined;

  const token = `pst-v1:${createHash("sha256").update(rawIdentity).digest("hex")}`;
  return isProcessStartToken(token) ? token : undefined;
}

function readLegacyRawProcessStartIdentity(pid: number): string | undefined {
  switch (process.platform) {
    case "linux":
    case "android":
      return readLegacyLinuxProcessStartIdentity(pid);
    case "darwin":
      return readLegacyDarwinProcessStartIdentity(pid);
    case "win32":
      return readLegacyWindowsProcessStartIdentity(pid);
    default:
      return readLegacyPosixProcessStartIdentity(pid);
  }
}

function readLegacyLinuxProcessStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;

    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u);
    const startTime = fields[19];
    if (startTime === undefined || !/^\d+$/u.test(startTime)) return undefined;

    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    return bootId.length > 0 ? `linux:${bootId}:${startTime}` : undefined;
  } catch {
    return undefined;
  }
}

function readLegacyDarwinProcessStartIdentity(pid: number): string | undefined {
  const startedAt = runLegacyIdentityCommand("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
  const bootTime = runLegacyIdentityCommand("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
  return startedAt === undefined || bootTime === undefined
    ? undefined
    : `darwin:${bootTime}:${startedAt}`;
}

function readLegacyWindowsProcessStartIdentity(pid: number): string | undefined {
  const script =
    `$p = Get-Process -Id ${String(pid)} -ErrorAction Stop; ` +
    "$p.StartTime.ToUniversalTime().Ticks";
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const startedAt =
    runLegacyIdentityCommand("powershell.exe", args) ?? runLegacyIdentityCommand("pwsh.exe", args);
  return startedAt !== undefined && /^\d+$/u.test(startedAt) ? `win32:${startedAt}` : undefined;
}

function readLegacyPosixProcessStartIdentity(pid: number): string | undefined {
  const startedAt = runLegacyIdentityCommand("ps", ["-p", String(pid), "-o", "lstart="]);
  return startedAt === undefined ? undefined : `${process.platform}:${startedAt}`;
}

function runLegacyIdentityCommand(command: string, args: readonly string[]): string | undefined {
  try {
    const result = spawnSync(command, [...args], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      shell: false,
      timeout: 2_000,
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

function restoreTimeZone(timeZone: string | undefined): void {
  if (timeZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = timeZone;
  }
}

test("Windows identity only uses absolute PowerShell paths under SystemRoot / ProgramFiles", () => {
  const seen: string[] = [];
  const exists = (path: string) => {
    seen.push(path);
    return true;
  };
  assert.deepEqual(
    resolveTrustedWindowsPowerShellExecutables(
      { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
      exists,
    ),
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ],
  );
  assert.deepEqual(seen, [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ]);
  assert.deepEqual(
    resolveTrustedWindowsPowerShellExecutables({ SystemRoot: "Windows" }, () => true),
    [],
  );
  assert.deepEqual(
    resolveTrustedWindowsPowerShellExecutables({ SystemRoot: "C:\\Windows" }, () => false),
    [],
  );
  assert.deepEqual(
    resolveTrustedWindowsPowerShellExecutables({ PATH: "C:\\evil" }, () => true),
    [],
  );
});

test("identity command timeout is 8 s on Windows and 2 s elsewhere", () => {
  assert.equal(identityCommandTimeoutMs("win32"), 8_000);
  assert.equal(identityCommandTimeoutMs("darwin"), 2_000);
  assert.equal(identityCommandTimeoutMs("linux"), 2_000);
  assert.deepEqual(
    resolveTrustedWindowsPowerShellExecutables({ WINDIR: "D:\\Win" }, () => true),
    ["D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
  );
});

test("Windows identity ignores a PATH-resolved powershell.exe and runs the trusted SystemRoot executable", () => {
  if (process.platform === "win32") {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "roll-trusted-powershell-"));
  const shadowDir = join(dir, "shadow");
  mkdirSync(shadowDir);
  const trustedName = [
    "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ].join("\\");
  const script = (ticks: string) => `#!/bin/sh\necho ${ticks}\n`;
  writeFileSync(join(shadowDir, "powershell.exe"), script("111111111111111111"), { mode: 0o755 });
  writeFileSync(join(shadowDir, "pwsh.exe"), script("222222222222222222"), { mode: 0o755 });
  writeFileSync(join(dir, trustedName), script("637000000000000000"), { mode: 0o755 });
  const originalCwd = process.cwd();
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const envKeys = [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ProgramFiles",
    "PROGRAMFILES",
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.chdir(dir);
    for (const key of envKeys) {
      delete process.env[key];
    }
    process.env.PATH = `${shadowDir}:${dir}:${originalEnv.PATH ?? ""}`;
    process.env.SystemRoot = "C:\\Windows";
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    assert.equal(
      readProcessStartToken(process.pid),
      `pst-v2:${createHash("sha256").update("win32-v2:637000000000000000").digest("hex")}`,
    );
  } finally {
    if (platformDescriptor !== undefined) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
    process.chdir(originalCwd);
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
