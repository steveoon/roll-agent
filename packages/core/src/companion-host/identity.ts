import { SpawnProcessRunner, type ProcessRunner } from "./process-runner.ts";
import { resolveWindowsWhoAmIExecutable } from "./windows-system.ts";

const WINDOWS_SERVICE_ACCOUNT_SIDS = new Set(["S-1-5-18", "S-1-5-19", "S-1-5-20"]);
const WINDOWS_SID_PATTERN = /\bS-\d+(?:-\d+)+\b/iu;

export type CompanionUserIdentityCheck = () => Promise<void>;

export function parseWindowsUserSid(stdout: string): string | undefined {
  return WINDOWS_SID_PATTERN.exec(stdout)?.[0]?.toUpperCase();
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
      if (WINDOWS_SERVICE_ACCOUNT_SIDS.has(sid)) {
        throw new Error("Roll Companion must not run as a Windows service account");
      }
    };
  }
  throw new Error("roll companion supports macOS and Windows only");
}
