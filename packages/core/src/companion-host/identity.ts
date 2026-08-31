import { SpawnProcessRunner, type ProcessRunner } from "./process-runner.ts";
import { resolveWindowsWhoAmIExecutable } from "./windows-system.ts";

const WINDOWS_SERVICE_ACCOUNT_SIDS = new Set(["S-1-5-18", "S-1-5-19", "S-1-5-20"]);
const WINDOWS_SID_PATTERN = /^S-\d+(?:-\d+)+$/iu;
const WHOAMI_CSV_LAST_FIELD_PATTERN = /"([^"]*)"\s*$/u;

export type CompanionUserIdentityCheck = () => Promise<void>;

export function parseWindowsUserSid(stdout: string): string | undefined {
  const lastLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  const lastField =
    lastLine === undefined ? undefined : WHOAMI_CSV_LAST_FIELD_PATTERN.exec(lastLine)?.[1];
  if (lastField === undefined || !WINDOWS_SID_PATTERN.test(lastField)) {
    return undefined;
  }
  return lastField.toUpperCase();
}

export function isWindowsServiceAccountSid(sid: string): boolean {
  return WINDOWS_SERVICE_ACCOUNT_SIDS.has(sid.toUpperCase());
}

export function createCompanionUserIdentityCheck(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly uid?: number;
    readonly runner?: ProcessRunner;
    readonly windowsDirectory?: string;
  } = {},
): CompanionUserIdentityCheck {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return async () => {
      const uid = options.uid ?? process.getuid?.();
      if (uid === undefined) {
        throw new Error("Unable to identify the current macOS Companion user");
      }
      if (uid === 0) {
        throw new Error("Roll Companion must not run as root");
      }
    };
  }
  if (platform === "win32") {
    const runner = options.runner ?? new SpawnProcessRunner();
    const whoAmIExecutable = resolveWindowsWhoAmIExecutable(options.windowsDirectory);
    return async () => {
      const result = await runner.run({
        command: whoAmIExecutable,
        args: ["/user", "/fo", "csv", "/nh"],
      });
      const sid = result.code === 0 ? parseWindowsUserSid(result.stdout) : undefined;
      if (sid === undefined) {
        throw new Error("Unable to identify the current Windows Companion user");
      }
      if (isWindowsServiceAccountSid(sid)) {
        throw new Error("Roll Companion must not run as a Windows service account");
      }
    };
  }
  throw new Error("roll companion supports macOS and Windows only");
}
