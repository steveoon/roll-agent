import type { CommandClassification } from "../../types/command-classification.ts";
import { auditFlags, FLAG_AUDITORS } from "./flag-audit.ts";
import { auditGit } from "./git-audit.ts";
import { isDangerous } from "./dangerous.ts";
import { executableLookupKey } from "./lookup-key.ts";
import { isSafeExecutable } from "./safe-list.ts";
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

function classifySegment(
  argv: readonly string[],
  platform: NodeJS.Platform,
): CommandClassification {
  const argv0 = argv[0];
  if (argv0 === undefined) {
    return "unknown";
  }
  if (isDangerous(argv, platform)) {
    return "dangerous";
  }
  const key = executableLookupKey(argv0, platform);
  if (key === "git") {
    return auditGit(argv) === "safe" ? "known-safe" : "unknown";
  }
  if (Object.hasOwn(FLAG_AUDITORS, key)) {
    return auditFlags(key, argv) === "safe" ? "known-safe" : "unknown";
  }
  if (isSafeExecutable(key, platform)) {
    return "known-safe";
  }
  return "unknown";
}

export function classifyScript(script: string, platform: NodeJS.Platform): CommandClassification {
  if (containsDangerousMetachar(script)) {
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
    const verdict = classifySegment(segment, platform);
    if (verdict === "dangerous") {
      return "dangerous";
    }
    if (verdict !== "known-safe") {
      allSafe = false;
    }
  }
  return allSafe ? "known-safe" : "unknown";
}
