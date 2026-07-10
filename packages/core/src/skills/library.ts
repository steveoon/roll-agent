import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import type { RegisteredAgent } from "../types/agent.ts";
import { collectReferencedSkillPaths, readReferencedSkillDocument } from "./documents.ts";

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

export interface CreateSkillLibraryOptions {
  readonly agents?: readonly RegisteredAgent[];
  readonly extraDirs?: readonly string[];
  readonly cwd?: string;
  readonly home?: string;
  readonly onIssue?: (message: string) => void;
}

interface SkillEntry {
  readonly summary: SkillSummary;
  readonly skillPath?: string;
  readonly fallbackContent?: string;
}

export const SKILL_FILE_NAME = "SKILL.md";
export const SKILL_TOOL_ID = "roll__skill";

export function getAgentSkillPath(agent: RegisteredAgent): string {
  return resolve(agent.installPath, SKILL_FILE_NAME);
}

export function resolveAgentSkillPath(agent: RegisteredAgent): string | undefined {
  const skillPath = getAgentSkillPath(agent);
  return existsSync(skillPath) ? skillPath : undefined;
}

export function findProjectSkillsDir(cwd: string): string | undefined {
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, ".agents", "skills");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function parseSkillFile(
  skillPath: string,
  fallbackName: string,
  source: SkillSource,
  onIssue: ((message: string) => void) | undefined,
): SkillEntry | undefined {
  let raw: string;
  try {
    raw = readFileSync(skillPath, "utf-8");
  } catch (error) {
    onIssue?.(`无法读取 ${skillPath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  let data: Record<string, unknown>;
  try {
    data = matter(raw).data as Record<string, unknown>;
  } catch (error) {
    onIssue?.(
      `SKILL.md frontmatter 解析失败 ${skillPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  const name =
    typeof data["name"] === "string" && data["name"].length > 0 ? data["name"] : fallbackName;
  const description = typeof data["description"] === "string" ? data["description"].trim() : "";
  return {
    summary: { name, description, source },
    skillPath,
  };
}

function collectDirectorySkills(
  dir: string,
  source: SkillSource,
  onIssue: ((message: string) => void) | undefined,
): SkillEntry[] {
  if (!isDirectory(dir)) {
    return [];
  }
  const directSkill = join(dir, SKILL_FILE_NAME);
  if (existsSync(directSkill)) {
    const entry = parseSkillFile(directSkill, basename(dir), source, onIssue);
    return entry ? [entry] : [];
  }
  const entries: SkillEntry[] = [];
  let children: string[];
  try {
    children = readdirSync(dir);
  } catch {
    return [];
  }
  for (const child of children.sort()) {
    const childDir = join(dir, child);
    if (!isDirectory(childDir)) {
      continue;
    }
    const skillPath = join(childDir, SKILL_FILE_NAME);
    if (!existsSync(skillPath)) {
      continue;
    }
    const entry = parseSkillFile(skillPath, child, source, onIssue);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function collectAgentSkills(agents: readonly RegisteredAgent[]): SkillEntry[] {
  return agents.map((agent) => {
    const skillPath = resolveAgentSkillPath(agent);
    const body = agent.skillBody?.trim();
    return {
      summary: {
        name: agent.skill.name,
        description: agent.skill.description,
        source: "agent" as const,
      },
      ...(skillPath !== undefined ? { skillPath } : {}),
      ...(body && body.length > 0 ? { fallbackContent: body } : {}),
    };
  });
}

export function createSkillLibrary(options: CreateSkillLibraryOptions = {}): SkillLibrary {
  const onIssue = options.onIssue;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();

  const candidates: SkillEntry[] = [...collectAgentSkills(options.agents ?? [])];
  const projectDir = findProjectSkillsDir(cwd);
  if (projectDir !== undefined) {
    candidates.push(...collectDirectorySkills(projectDir, "project", onIssue));
  }
  candidates.push(...collectDirectorySkills(join(home, ".agents", "skills"), "user", onIssue));
  for (const extraDir of options.extraDirs ?? []) {
    candidates.push(...collectDirectorySkills(extraDir, "config", onIssue));
  }

  const byName = new Map<string, SkillEntry>();
  const seenPaths = new Set<string>();
  for (const entry of candidates) {
    const realPath = entry.skillPath !== undefined ? safeRealpath(entry.skillPath) : undefined;
    if (realPath !== undefined && seenPaths.has(realPath)) {
      continue;
    }
    if (byName.has(entry.summary.name)) {
      onIssue?.(
        `skill "${entry.summary.name}" 重名，保留 ${byName.get(entry.summary.name)?.summary.source} 来源，跳过 ${entry.summary.source} 来源`,
      );
      continue;
    }
    byName.set(entry.summary.name, entry);
    if (realPath !== undefined) {
      seenPaths.add(realPath);
    }
  }

  const loadEntry = (name: string): LoadedSkill | undefined => {
    const entry = byName.get(name);
    if (!entry) {
      return undefined;
    }
    if (entry.skillPath !== undefined) {
      let content: string;
      try {
        content = readFileSync(entry.skillPath, "utf-8");
      } catch (error) {
        onIssue?.(
          `无法读取 ${entry.skillPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
      return {
        summary: entry.summary,
        content,
        referencePaths: collectReferencedSkillPaths(content),
        skillRoot: dirname(safeRealpath(entry.skillPath) ?? resolve(entry.skillPath)),
      };
    }
    if (entry.fallbackContent !== undefined) {
      return { summary: entry.summary, content: entry.fallbackContent, referencePaths: [] };
    }
    return { summary: entry.summary, content: entry.summary.description, referencePaths: [] };
  };

  const loadReferenceDocument = (
    name: string,
    referencePath: string,
  ): LoadedSkillReference | undefined => {
    const entry = byName.get(name);
    if (!entry || entry.skillPath === undefined) {
      return undefined;
    }
    const reference = readReferencedSkillDocument(entry.skillPath, referencePath);
    if (reference === undefined) {
      return undefined;
    }
    return {
      content: reference.content,
      skillRoot: dirname(safeRealpath(entry.skillPath) ?? resolve(entry.skillPath)),
    };
  };

  return {
    list: () => [...byName.values()].map((entry) => entry.summary),
    load: loadEntry,
    loadReference: (name, referencePath) => loadReferenceDocument(name, referencePath)?.content,
    loadReferenceDocument,
  };
}
