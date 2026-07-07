import type { AuditVerdict, FlagAuditor } from "./types.ts";

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

const RG_DENY_FLAGS: ReadonlySet<string> = new Set(["--search-zip", "-z"]);
const RG_DENY_VALUE_FLAGS = ["--pre", "--hostname-bin"] as const;

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
  rg: auditRipgrep,
  base64: auditBase64,
  sed: auditSed,
};

export function auditFlags(key: string, argv: readonly string[]): AuditVerdict {
  const auditor = FLAG_AUDITORS[key];
  return auditor ? auditor(argv) : "safe";
}
