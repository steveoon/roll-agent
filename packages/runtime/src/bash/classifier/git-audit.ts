import type { AuditVerdict } from "./types.ts";

const GIT_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
]);

const UNSAFE_GLOBAL_EXACT: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "-p",
  "--paginate",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

const UNSAFE_GLOBAL_PREFIXES = [
  "--config-env=",
  "--exec-path=",
  "--git-dir=",
  "--namespace=",
  "--super-prefix=",
  "--work-tree=",
] as const;

function isUnsafeGlobalOption(token: string): boolean {
  if (UNSAFE_GLOBAL_EXACT.has(token)) {
    return true;
  }
  if ((token.startsWith("-C") || token.startsWith("-c")) && token.length > 2) {
    return true;
  }
  return UNSAFE_GLOBAL_PREFIXES.some((prefix) => token.startsWith(prefix));
}

function isUnsafeSubcommandOption(token: string): boolean {
  return (
    token === "--output" ||
    token.startsWith("--output=") ||
    token === "--ext-diff" ||
    token === "--textconv" ||
    token === "--exec" ||
    token.startsWith("--exec=")
  );
}

const READONLY_BRANCH_FLAGS: ReadonlySet<string> = new Set([
  "--list",
  "-l",
  "--show-current",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
]);

function auditGitBranch(subArgs: readonly string[]): AuditVerdict {
  for (const arg of subArgs) {
    if (READONLY_BRANCH_FLAGS.has(arg) || arg.startsWith("--format=")) {
      continue;
    }
    return "reject";
  }
  return "safe";
}

export function auditGit(argv: readonly string[]): AuditVerdict {
  const rest = argv.slice(1);
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (token === undefined) {
      return "reject";
    }
    if (isUnsafeGlobalOption(token)) {
      return "reject";
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }

  const subcommand = rest[index];
  if (subcommand === undefined || !GIT_SAFE_SUBCOMMANDS.has(subcommand)) {
    return "reject";
  }

  const subArgs = rest.slice(index + 1);
  for (const arg of subArgs) {
    if (isUnsafeSubcommandOption(arg)) {
      return "reject";
    }
  }

  if (subcommand === "branch") {
    return auditGitBranch(subArgs);
  }
  return "safe";
}
