export interface SkillInvocationSummary {
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

export interface SkillInvocation {
  readonly skills: readonly SkillInvocationSummary[];
  readonly prompt: string;
}

export const SKILL_INVOCATION_PARSE_KINDS = {
  none: "none",
  valid: "valid",
  unknown: "unknown",
} as const;

export type SkillInvocationParseResult =
  | { readonly kind: typeof SKILL_INVOCATION_PARSE_KINDS.none }
  | {
      readonly kind: typeof SKILL_INVOCATION_PARSE_KINDS.valid;
      readonly invocation: SkillInvocation;
    }
  | {
      readonly kind: typeof SKILL_INVOCATION_PARSE_KINDS.unknown;
      readonly token: string;
    };

const SLASH_COMMAND_TOKEN_RE = /^\/[\w-]*$/;

export function isSlashCommandToken(token: string): boolean {
  return SLASH_COMMAND_TOKEN_RE.test(token);
}

export function isSlashCommandShaped(input: string): boolean {
  return isSlashCommandToken(input.split(/\s+/, 1)[0] ?? "");
}

export function findSkillBySlashName(
  token: string,
  skills: readonly SkillInvocationSummary[],
): SkillInvocationSummary | undefined {
  const normalized = token.toLowerCase();
  return skills.find((skill) => `/${skill.name}`.toLowerCase() === normalized);
}

/** Parses one or more known leading /skill tokens without rewriting the user's request. */
export function parseSkillInvocationResult(
  input: string,
  skills: readonly SkillInvocationSummary[],
): SkillInvocationParseResult {
  let rest = input.trimStart();
  const selected: SkillInvocationSummary[] = [];
  const seen = new Set<string>();
  while (true) {
    const match = /^(\/\S+)(\s*)/.exec(rest);
    if (!match) {
      break;
    }
    const token = match[1] ?? "";
    if (!isSlashCommandToken(token)) {
      break;
    }
    const skill = findSkillBySlashName(token, skills);
    if (!skill) {
      return { kind: SKILL_INVOCATION_PARSE_KINDS.unknown, token };
    }
    const key = skill.name.toLowerCase();
    if (!seen.has(key)) {
      selected.push(skill);
      seen.add(key);
    }
    rest = rest.slice(match[0].length);
  }
  if (selected.length === 0) {
    return { kind: SKILL_INVOCATION_PARSE_KINDS.none };
  }
  return {
    kind: SKILL_INVOCATION_PARSE_KINDS.valid,
    invocation: {
      skills: selected,
      prompt: rest.trim(),
    },
  };
}

export function parseSkillInvocation(
  input: string,
  skills: readonly SkillInvocationSummary[],
): SkillInvocation | undefined {
  const result = parseSkillInvocationResult(input, skills);
  return result.kind === SKILL_INVOCATION_PARSE_KINDS.valid ? result.invocation : undefined;
}
