export const SKILL_SOURCES = ["agent", "project", "user", "config"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
}

export interface LoadedSkill {
  readonly summary: SkillSummary;
  readonly content: string;
  readonly referencePaths: readonly string[];
  readonly skillRoot?: string;
}

export interface LoadedSkillReference {
  readonly content: string;
  readonly skillRoot?: string;
}

export interface SkillLibrary {
  list(): readonly SkillSummary[];
  load(name: string): LoadedSkill | undefined;
  loadReference(name: string, referencePath: string): string | undefined;
  loadReferenceDocument?(name: string, referencePath: string): LoadedSkillReference | undefined;
}

export const SKILL_TOOL_ID = "roll__skill";
