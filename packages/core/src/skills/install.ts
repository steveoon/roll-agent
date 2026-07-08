import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { sanitizeInstallId } from "../registry/source.ts";

const SKILL_FILE_NAME = "SKILL.md";

export interface SkillInstallCandidate {
  readonly name: string;
  readonly description: string;
  readonly sourceDir: string;
}

export interface CollectInstallableSkillsResult {
  readonly skills: readonly SkillInstallCandidate[];
  readonly issues: readonly string[];
}

export interface InstalledSkillRecord {
  readonly name: string;
  readonly targetPath: string;
  readonly overwritten: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseInstallableSkill(dir: string): {
  readonly skill?: SkillInstallCandidate;
  readonly issue?: string;
} {
  const skillPath = join(dir, SKILL_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(skillPath, "utf-8");
  } catch (error) {
    return { issue: `无法读取 ${skillPath}: ${errorMessage(error)}` };
  }

  let data: Record<string, unknown>;
  try {
    data = matter(raw).data as Record<string, unknown>;
  } catch (error) {
    return { issue: `SKILL.md frontmatter 解析失败 ${skillPath}: ${errorMessage(error)}` };
  }

  const name = data["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    return { issue: `${skillPath} 缺少有效的 frontmatter name，已跳过` };
  }
  const description = data["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    return { issue: `${skillPath} 缺少有效的 frontmatter description，已跳过` };
  }

  return {
    skill: { name: name.trim(), description: description.trim(), sourceDir: dir },
  };
}

export function collectInstallableSkills(sourceDir: string): CollectInstallableSkillsResult {
  const root = resolve(sourceDir);
  if (!isDirectory(root)) {
    return { skills: [], issues: [`目录不存在: ${root}`] };
  }

  if (existsSync(join(root, SKILL_FILE_NAME))) {
    const { skill, issue } = parseInstallableSkill(root);
    return { skills: skill ? [skill] : [], issues: issue ? [issue] : [] };
  }

  const skills: SkillInstallCandidate[] = [];
  const issues: string[] = [];
  let children: string[];
  try {
    children = readdirSync(root);
  } catch (error) {
    return { skills: [], issues: [`无法读取目录 ${root}: ${errorMessage(error)}`] };
  }

  for (const child of children.sort()) {
    const childDir = join(root, child);
    if (!isDirectory(childDir) || !existsSync(join(childDir, SKILL_FILE_NAME))) {
      continue;
    }
    const { skill, issue } = parseInstallableSkill(childDir);
    if (skill) {
      skills.push(skill);
    }
    if (issue) {
      issues.push(issue);
    }
  }

  if (skills.length === 0 && issues.length === 0) {
    issues.push(`未在 ${root} 找到包含 SKILL.md 的 skill 目录`);
  }

  return { skills, issues };
}

export function installSkillsToDir(
  skills: readonly SkillInstallCandidate[],
  targetSkillsDir: string,
): readonly InstalledSkillRecord[] {
  mkdirSync(targetSkillsDir, { recursive: true });
  return skills.map((skill) => {
    const targetPath = join(targetSkillsDir, sanitizeInstallId(skill.name));
    const overwritten = existsSync(targetPath);
    if (overwritten) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    cpSync(skill.sourceDir, targetPath, { recursive: true });
    return { name: skill.name, targetPath, overwritten };
  });
}

export function findExistingSkillInstalls(
  skills: readonly SkillInstallCandidate[],
  targetSkillsDir: string,
): readonly string[] {
  return skills
    .filter((skill) => existsSync(join(targetSkillsDir, sanitizeInstallId(skill.name))))
    .map((skill) => skill.name);
}
