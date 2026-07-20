import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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

const PATTERN_FIRST_COMMANDS: ReadonlySet<string> = new Set(["grep", "rg", "sed"]);

const PATH_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  grep: ["-f", "--file", "--exclude-from"],
  rg: ["-f", "--file", "--ignore-file"],
};

const PATTERN_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  grep: ["-e", "--regexp", "-f", "--file"],
  rg: ["-e", "--regexp", "-f", "--file"],
};

export function isEscapingPathArg(arg: string): boolean {
  if (arg.startsWith("/") || arg.startsWith("~")) {
    return true;
  }
  return arg.split("/").includes("..");
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function auditResolvedPath(arg: string, workdir: string): AuditVerdict {
  if (isEscapingPathArg(arg)) {
    return "reject";
  }

  try {
    lstatSync(resolve(workdir, arg));
  } catch {
    // A path that does not exist at admission time can be created through an
    // escaping symlink before execution. Unknown paths therefore cannot prove
    // the workspace-containment invariant required for auto approval.
    return "reject";
  }

  try {
    const canonicalRoot = realpathSync(workdir);
    const canonicalCandidate = realpathSync(resolve(workdir, arg));
    return isWithinRoot(canonicalRoot, canonicalCandidate) ? "safe" : "reject";
  } catch {
    // A broken link is still an unresolved filesystem indirection. It must not
    // inherit known-safe status merely because realpath cannot follow it yet.
    return "reject";
  }
}

interface FlagValueMatch {
  readonly value: string;
  readonly consumesNext: boolean;
}

function matchFlagValue(
  arg: string,
  next: string | undefined,
  flags: readonly string[],
): FlagValueMatch | undefined {
  for (const flag of flags) {
    if (arg === flag) {
      return next === undefined ? undefined : { value: next, consumesNext: true };
    }
    if (arg.startsWith(`${flag}=`)) {
      return { value: arg.slice(flag.length + 1), consumesNext: false };
    }
    if (flag.length === 2 && arg.startsWith(flag) && arg.length > 2) {
      return { value: arg.slice(2), consumesNext: false };
    }
  }
  return undefined;
}

function auditFindPaths(argv: readonly string[], workdir: string): AuditVerdict {
  let sawPath = false;
  for (const arg of argv.slice(1)) {
    if (arg === "--") {
      // A dash-prefixed filename after `--` is ambiguous with find's large
      // expression language. Keep that form behind confirmation.
      return "reject";
    }
    if (!sawPath && (arg === "-H" || arg === "-L" || arg === "-P")) {
      continue;
    }
    if (arg.startsWith("-") || arg === "!" || arg === "(") {
      break;
    }
    sawPath = true;
    if (auditResolvedPath(arg, workdir) !== "safe") {
      return "reject";
    }
  }
  return "safe";
}

export function auditPathArgs(key: string, argv: readonly string[], workdir: string): AuditVerdict {
  if (NO_PATH_ARG_COMMANDS.has(key)) {
    return "safe";
  }
  if (key === "find") {
    return auditFindPaths(argv, workdir);
  }

  const pathValueFlags = PATH_VALUE_FLAGS[key] ?? [];
  const patternValueFlags = PATTERN_VALUE_FLAGS[key] ?? [];
  let patternSkipped = !PATTERN_FIRST_COMMANDS.has(key);
  let optionsEnded = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      return "reject";
    }

    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && arg.startsWith("-")) {
      const next = argv[index + 1];
      const pathValue = matchFlagValue(arg, next, pathValueFlags);
      if (pathValue !== undefined) {
        if (auditResolvedPath(pathValue.value, workdir) !== "safe") {
          return "reject";
        }
        if (
          patternValueFlags.includes(arg) ||
          patternValueFlags.some((flag) => arg.startsWith(flag))
        ) {
          patternSkipped = true;
        }
        if (pathValue.consumesNext) {
          index += 1;
        }
        continue;
      }

      const patternValue = matchFlagValue(arg, next, patternValueFlags);
      if (patternValue !== undefined) {
        patternSkipped = true;
        if (patternValue.consumesNext) {
          index += 1;
        }
      }
      continue;
    }

    if (!patternSkipped) {
      patternSkipped = true;
      continue;
    }
    if (auditResolvedPath(arg, workdir) !== "safe") {
      return "reject";
    }
  }
  return "safe";
}
