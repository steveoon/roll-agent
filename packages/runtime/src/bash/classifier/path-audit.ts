import type { AuditVerdict } from "./types.ts";

const NO_PATH_ARG_COMMANDS: ReadonlySet<string> = new Set([
  "echo",
  "expr",
  "false",
  "true",
  "id",
  "pwd",
  "seq",
  "tr",
  "uname",
  "whoami",
  "which",
]);

const PATTERN_FIRST_COMMANDS: ReadonlySet<string> = new Set(["grep", "rg"]);

export function isEscapingPathArg(arg: string): boolean {
  if (arg.startsWith("/") || arg.startsWith("~")) {
    return true;
  }
  return arg.split("/").includes("..");
}

export function auditPathArgs(key: string, argv: readonly string[]): AuditVerdict {
  if (NO_PATH_ARG_COMMANDS.has(key)) {
    return "safe";
  }
  let patternSkipped = !PATTERN_FIRST_COMMANDS.has(key);
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) {
      continue;
    }
    if (!patternSkipped) {
      patternSkipped = true;
      continue;
    }
    if (isEscapingPathArg(arg)) {
      return "reject";
    }
  }
  return "safe";
}
