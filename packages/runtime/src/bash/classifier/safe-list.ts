import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";

const UNIVERSAL_SAFE_COMMANDS = [
  "cat",
  "cut",
  "echo",
  "expr",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
] as const;

const LINUX_ONLY_SAFE_COMMANDS = ["numfmt", "tac"] as const;

const UNIVERSAL_SET: ReadonlySet<string> = new Set(UNIVERSAL_SAFE_COMMANDS);
const LINUX_SET: ReadonlySet<string> = new Set(LINUX_ONLY_SAFE_COMMANDS);

const POSIX_SHELL_BUILTINS: ReadonlySet<string> = new Set(["echo", "false", "pwd", "true"]);
const TRUSTED_POSIX_EXECUTABLE_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

/**
 * Auto-approved commands execute with the same fixed system PATH. Checking the
 * candidate here prevents workspace/node_modules PATH shadowing from turning a
 * read-only command name into arbitrary code execution.
 */
export function isTrustedExecutable(key: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return false;
  }
  if (POSIX_SHELL_BUILTINS.has(key)) {
    return true;
  }
  for (const directory of TRUSTED_POSIX_EXECUTABLE_DIRS) {
    try {
      accessSync(join(directory, key), fsConstants.X_OK);
      return true;
    } catch {
      // Try the next fixed system directory.
    }
  }
  return false;
}

export function isSafeExecutable(key: string, platform: NodeJS.Platform): boolean {
  if (UNIVERSAL_SET.has(key)) {
    return true;
  }
  return platform === "linux" && LINUX_SET.has(key);
}
