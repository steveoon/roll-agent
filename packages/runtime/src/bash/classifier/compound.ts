import type { CommandClassification } from "../../types/command-classification.ts";
import { auditFlags, FLAG_AUDITORS } from "./flag-audit.ts";
import { auditGit } from "./git-audit.ts";
import { auditPathArgs } from "./path-audit.ts";
import { isDangerous } from "./dangerous.ts";
import { executableLookupKey } from "./lookup-key.ts";
import { isSafeExecutable, isTrustedExecutable } from "./safe-list.ts";
import { tokenizeScript } from "./tokenize.ts";

const DANGEROUS_METACHARS = ["$", "`", ">", "<", "(", ")", "{", "}", "\\"] as const;

export function containsDangerousMetachar(script: string): boolean {
  for (const ch of DANGEROUS_METACHARS) {
    if (script.includes(ch)) {
      return true;
    }
  }
  return script.replace(/&&/g, "").includes("&");
}

export function containsUnquotedGlob(script: string): boolean {
  let quote: "'" | '"' | undefined;
  for (const ch of script) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "*" || ch === "?" || ch === "[") {
      return true;
    }
  }
  return false;
}

function classifySegment(
  argv: readonly string[],
  platform: NodeJS.Platform,
  workdir: string,
): CommandClassification {
  const argv0 = argv[0];
  if (argv0 === undefined) {
    return "unknown";
  }
  if (isDangerous(argv, platform)) {
    return "dangerous";
  }
  if (argv0.includes("/") || argv0.includes("\\")) {
    return "unknown";
  }
  const key = executableLookupKey(argv0, platform);
  if (!isTrustedExecutable(key, platform)) {
    return "unknown";
  }
  if (auditPathArgs(key, argv, workdir) !== "safe") {
    return "unknown";
  }
  if (key === "git") {
    return auditGit(argv, workdir) === "safe" ? "known-safe" : "unknown";
  }
  if (Object.hasOwn(FLAG_AUDITORS, key)) {
    return auditFlags(key, argv) === "safe" ? "known-safe" : "unknown";
  }
  if (isSafeExecutable(key, platform)) {
    return "known-safe";
  }
  return "unknown";
}

export function classifyScript(
  script: string,
  platform: NodeJS.Platform,
  workdir = "",
): CommandClassification {
  if (containsDangerousMetachar(script) || containsUnquotedGlob(script)) {
    return "unknown";
  }
  const lexemes = tokenizeScript(script);
  if (lexemes === null) {
    return "unknown";
  }

  const segments: string[][] = [];
  const separators: string[] = [];
  let current: string[] = [];
  for (const lexeme of lexemes) {
    if (lexeme.kind === "op") {
      segments.push(current);
      separators.push(lexeme.value);
      current = [];
    } else {
      current.push(lexeme.value);
    }
  }
  segments.push(current);

  const lastSegment = segments[segments.length - 1];
  if (
    lastSegment !== undefined &&
    lastSegment.length === 0 &&
    separators[separators.length - 1] === ";"
  ) {
    segments.pop();
  }

  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return "unknown";
  }

  let allSafe = true;
  for (const segment of segments) {
    const verdict = classifySegment(segment, platform, workdir);
    if (verdict === "dangerous") {
      return "dangerous";
    }
    if (verdict !== "known-safe") {
      allSafe = false;
    }
  }
  return allSafe ? "known-safe" : "unknown";
}
