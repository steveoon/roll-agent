import type { AuditVerdict, FlagAuditor } from "./types.ts";
import { isEscapingPathArg } from "./path-audit.ts";

const FIND_DENY_FLAGS: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

const auditFind: FlagAuditor = (argv) => {
  for (const arg of argv.slice(1)) {
    if (FIND_DENY_FLAGS.has(arg)) {
      return "reject";
    }
  }
  return "safe";
};

function hasEscapingPathValue(argv: readonly string[], flags: readonly string[]): boolean {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    for (const flag of flags) {
      if (arg === flag) {
        const value = argv[i + 1];
        if (value === undefined || isEscapingPathArg(value)) {
          return true;
        }
        i += 1;
        break;
      }
      if (arg.startsWith(`${flag}=`) && isEscapingPathArg(arg.slice(flag.length + 1))) {
        return true;
      }
      if (flag.length === 2 && arg.startsWith(flag) && isEscapingPathArg(arg.slice(2))) {
        return true;
      }
    }
  }
  return false;
}

const GREP_PATH_VALUE_FLAGS = ["-f", "--file", "--exclude-from"] as const;

const auditGrep: FlagAuditor = (argv) => {
  return hasEscapingPathValue(argv, GREP_PATH_VALUE_FLAGS) ? "reject" : "safe";
};

const RG_DENY_FLAGS: ReadonlySet<string> = new Set(["--search-zip", "-z"]);
const RG_DENY_VALUE_FLAGS = ["--pre", "--hostname-bin"] as const;
const RG_PATH_VALUE_FLAGS = ["-f", "--file", "--ignore-file"] as const;

const auditRipgrep: FlagAuditor = (argv) => {
  for (const arg of argv.slice(1)) {
    if (RG_DENY_FLAGS.has(arg)) {
      return "reject";
    }
    for (const opt of RG_DENY_VALUE_FLAGS) {
      if (arg === opt || arg.startsWith(`${opt}=`)) {
        return "reject";
      }
    }
  }
  if (hasEscapingPathValue(argv, RG_PATH_VALUE_FLAGS)) {
    return "reject";
  }
  return "safe";
};

const auditBase64: FlagAuditor = (argv) => {
  for (const arg of argv.slice(1)) {
    if (arg === "--output" || arg.startsWith("--output=") || arg.startsWith("-o")) {
      return "reject";
    }
  }
  return "safe";
};

const SED_N_ARG = /^(\d+,)?\d+p$/;

const auditSed: FlagAuditor = (argv) => {
  const arg = argv[2];
  if (argv.length <= 4 && argv[1] === "-n" && arg !== undefined && SED_N_ARG.test(arg)) {
    return "safe";
  }
  return "reject";
};

export const FLAG_AUDITORS: Readonly<Record<string, FlagAuditor>> = {
  find: auditFind,
  grep: auditGrep,
  rg: auditRipgrep,
  base64: auditBase64,
  sed: auditSed,
};

export function auditFlags(key: string, argv: readonly string[]): AuditVerdict {
  const auditor = FLAG_AUDITORS[key];
  return auditor ? auditor(argv) : "safe";
}
