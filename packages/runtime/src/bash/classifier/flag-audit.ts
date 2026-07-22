import type { AuditVerdict, FlagAuditor } from "./types.ts";

interface ExactOptionPolicy {
  readonly booleanShort?: string;
  readonly valueShort?: string;
  readonly booleanLong?: ReadonlySet<string>;
  readonly valueLong?: ReadonlySet<string>;
}

/**
 * Auto approval intentionally recognizes only exact, common option spellings.
 * Unknown flags and GNU long-option abbreviations fall back to confirmation.
 */
function auditExactOptions(argv: readonly string[], policy: ExactOptionPolicy): AuditVerdict {
  const booleanShort = new Set(policy.booleanShort ?? "");
  const valueShort = new Set(policy.valueShort ?? "");
  let optionsEnded = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      return "reject";
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || arg === "-" || !arg.startsWith("-")) {
      continue;
    }

    if (arg.startsWith("--")) {
      const equalsAt = arg.indexOf("=");
      const name = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
      if (policy.booleanLong?.has(name)) {
        if (equalsAt !== -1) {
          return "reject";
        }
        continue;
      }
      if (!policy.valueLong?.has(name)) {
        return "reject";
      }
      if (equalsAt !== -1) {
        if (arg.slice(equalsAt + 1).length === 0) {
          return "reject";
        }
        continue;
      }
      if (argv[index + 1] === undefined) {
        return "reject";
      }
      index += 1;
      continue;
    }

    const cluster = arg.slice(1);
    if (cluster.length === 0) {
      continue;
    }
    for (let clusterIndex = 0; clusterIndex < cluster.length; clusterIndex += 1) {
      const flag = cluster[clusterIndex];
      if (flag === undefined) {
        return "reject";
      }
      if (booleanShort.has(flag)) {
        continue;
      }
      if (!valueShort.has(flag) || clusterIndex !== 0) {
        return "reject";
      }
      if (cluster.length === 1) {
        if (argv[index + 1] === undefined) {
          return "reject";
        }
        index += 1;
      }
      break;
    }
  }
  return "safe";
}

const FIND_VALUE_PREDICATES: ReadonlySet<string> = new Set([
  "-iname",
  "-maxdepth",
  "-mindepth",
  "-name",
  "-type",
]);
const FIND_BOOLEAN_PREDICATES: ReadonlySet<string> = new Set([
  "!",
  "(",
  ")",
  "-a",
  "-and",
  "-empty",
  "-not",
  "-o",
  "-or",
  "-print",
  "-print0",
]);

const auditFind: FlagAuditor = (argv) => {
  let inExpression = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || arg === "--" || arg === "-H" || arg === "-L") {
      return "reject";
    }
    if (!inExpression) {
      if (arg === "-P") {
        continue;
      }
      if (!arg.startsWith("-") && arg !== "!" && arg !== "(") {
        continue;
      }
      inExpression = true;
    }
    if (FIND_BOOLEAN_PREDICATES.has(arg)) {
      continue;
    }
    if (!FIND_VALUE_PREDICATES.has(arg) || argv[index + 1] === undefined) {
      return "reject";
    }
    index += 1;
  }
  return "safe";
};

const auditGrep: FlagAuditor = (argv) =>
  auditExactOptions(argv, {
    booleanShort: "EFGHILPabcghijklnoqrsvwxy",
    valueShort: "ABCDefm",
    booleanLong: new Set([
      "--basic-regexp",
      "--extended-regexp",
      "--files-with-matches",
      "--files-without-match",
      "--fixed-strings",
      "--ignore-case",
      "--invert-match",
      "--line-number",
      "--no-filename",
      "--only-matching",
      "--perl-regexp",
      "--quiet",
      "--recursive",
      "--silent",
      "--text",
      "--with-filename",
      "--word-regexp",
      "--line-regexp",
    ]),
    valueLong: new Set([
      "--after-context",
      "--before-context",
      "--binary-files",
      "--context",
      "--devices",
      "--directories",
      "--exclude",
      "--exclude-dir",
      "--exclude-from",
      "--file",
      "--include",
      "--label",
      "--max-count",
      "--regexp",
    ]),
  });

const auditRipgrep: FlagAuditor = (argv) =>
  auditExactOptions(argv, {
    booleanShort: "FHIJNPSUVachilnopqsuvwxy",
    valueShort: "ABCEMTdefgjmrt",
    booleanLong: new Set([
      "--case-sensitive",
      "--column",
      "--count",
      "--files-with-matches",
      "--files-without-match",
      "--fixed-strings",
      "--heading",
      "--hidden",
      "--ignore-case",
      "--invert-match",
      "--line-number",
      "--multiline",
      "--no-heading",
      "--no-ignore",
      "--no-line-number",
      "--only-matching",
      "--pcre2",
      "--quiet",
      "--smart-case",
      "--text",
      "--unrestricted",
      "--word-regexp",
      "--line-regexp",
    ]),
    valueLong: new Set([
      "--after-context",
      "--before-context",
      "--context",
      "--encoding",
      "--file",
      "--glob",
      "--ignore-file",
      "--max-columns",
      "--max-count",
      "--max-depth",
      "--regexp",
      "--replace",
      "--threads",
      "--type",
      "--type-not",
    ]),
  });

const auditBase64: FlagAuditor = (argv) =>
  auditExactOptions(argv, {
    booleanShort: "Dd",
    booleanLong: new Set(["--decode"]),
  });

const auditLs: FlagAuditor = (argv) =>
  auditExactOptions(argv, {
    booleanShort: "ABCFGRSUabcdfghiklmnopqrstux1",
    booleanLong: new Set([
      "--all",
      "--almost-all",
      "--classify",
      "--directory",
      "--human-readable",
      "--inode",
      "--long",
      "--numeric-uid-gid",
      "--recursive",
      "--reverse",
      "--size",
    ]),
  });

const auditWc: FlagAuditor = (argv) =>
  auditExactOptions(argv, {
    booleanShort: "Lclmw",
    booleanLong: new Set(["--bytes", "--chars", "--lines", "--max-line-length", "--words"]),
  });

const auditTail: FlagAuditor = (argv) =>
  auditExactOptions(argv, {
    booleanShort: "fqv",
    valueShort: "cn",
    booleanLong: new Set(["--quiet", "--silent", "--verbose"]),
    valueLong: new Set(["--bytes", "--lines"]),
  });

const SED_N_ARG = /^(\d+,)?\d+p$/;

const auditSed: FlagAuditor = (argv) => {
  const arg = argv[2];
  return argv.length <= 4 && argv[1] === "-n" && arg !== undefined && SED_N_ARG.test(arg)
    ? "safe"
    : "reject";
};

export const FLAG_AUDITORS: Readonly<Record<string, FlagAuditor>> = {
  base64: auditBase64,
  find: auditFind,
  grep: auditGrep,
  ls: auditLs,
  rg: auditRipgrep,
  sed: auditSed,
  tail: auditTail,
  wc: auditWc,
};

export function auditFlags(key: string, argv: readonly string[]): AuditVerdict {
  const auditor = FLAG_AUDITORS[key];
  return auditor ? auditor(argv) : "safe";
}
