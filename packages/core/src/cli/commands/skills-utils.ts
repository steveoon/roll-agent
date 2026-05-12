import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { RegisteredAgent } from "../../types/agent.ts";

const SKILL_FILE_NAME = "SKILL.md";
const REFERENCE_PATH_PATTERN = /(?:\.\/)?references\/[A-Za-z0-9._~!$&+,;=:@%/-]+/g;
const SUPPORTED_REFERENCE_EXTENSIONS = new Set([".md", ".yaml", ".yml", ".json", ".txt"]);

export type SkillDocumentSource = "filesystem" | "registry";

export interface AgentSkillReferenceDocument {
  readonly relativePath: string;
  readonly path: string;
  readonly content: string;
}

export interface AgentSkillDocument {
  readonly name: string;
  readonly description: string;
  readonly source: SkillDocumentSource;
  readonly content: string;
  readonly path?: string;
  readonly references?: readonly AgentSkillReferenceDocument[];
}

export interface AgentSkillListItem {
  readonly name: string;
  readonly description: string;
  readonly source: SkillDocumentSource;
  readonly path?: string;
}

export interface ResolveAgentSkillDocumentOptions {
  readonly includeReferences?: boolean;
}

export function getAgentSkillPath(agent: RegisteredAgent): string {
  return resolve(agent.installPath, SKILL_FILE_NAME);
}

export function resolveAgentSkillPath(agent: RegisteredAgent): string | undefined {
  const skillPath = getAgentSkillPath(agent);
  return existsSync(skillPath) ? skillPath : undefined;
}

export function resolveAgentSkillDocument(
  agent: RegisteredAgent,
  options: ResolveAgentSkillDocumentOptions = {},
): AgentSkillDocument {
  const skillPath = resolveAgentSkillPath(agent);
  if (skillPath) {
    const content = readFileSync(skillPath, "utf-8");
    return {
      name: agent.skill.name,
      description: agent.skill.description,
      source: "filesystem",
      path: skillPath,
      content,
      ...(options.includeReferences
        ? { references: readReferencedSkillDocuments(skillPath, content) }
        : {}),
    };
  }

  return {
    name: agent.skill.name,
    description: agent.skill.description,
    source: "registry",
    content: buildStoredSkillDocument(agent),
    ...(options.includeReferences ? { references: [] } : {}),
  };
}

export function listAgentSkills(agents: readonly RegisteredAgent[]): readonly AgentSkillListItem[] {
  return agents.map((agent) => {
    const skillPath = resolveAgentSkillPath(agent);
    return {
      name: agent.skill.name,
      description: agent.skill.description,
      source: skillPath ? "filesystem" : "registry",
      ...(skillPath ? { path: skillPath } : {}),
    };
  });
}

function buildStoredSkillDocument(agent: RegisteredAgent): string {
  const frontmatter = [
    "---",
    `name: ${formatYamlScalar(agent.skill.name)}`,
    `description: ${formatYamlScalar(agent.skill.description)}`,
  ];

  if (agent.skill.license) {
    frontmatter.push(`license: ${formatYamlScalar(agent.skill.license)}`);
  }

  if (agent.skill.compatibility) {
    frontmatter.push(`compatibility: ${formatYamlScalar(agent.skill.compatibility)}`);
  }

  frontmatter.push("---");
  const body = agent.skillBody?.trim();
  return `${frontmatter.join("\n")}\n\n${body && body.length > 0 ? body : agent.skill.description}\n`;
}

function formatYamlScalar(value: string): string {
  return JSON.stringify(value);
}

function readReferencedSkillDocuments(
  skillPath: string,
  content: string,
): readonly AgentSkillReferenceDocument[] {
  const skillDir = dirname(skillPath);
  const realSkillDir = realpathSync(skillDir);
  const references: AgentSkillReferenceDocument[] = [];

  for (const relativePath of collectReferencedSkillPaths(content)) {
    const reference = readReferenceDocument(skillDir, realSkillDir, relativePath);
    if (reference) {
      references.push(reference);
    }
  }

  return references;
}

function collectReferencedSkillPaths(content: string): readonly string[] {
  const references = new Set<string>();
  for (const match of content.matchAll(REFERENCE_PATH_PATTERN)) {
    const normalized = normalizeReferencePath(match[0]);
    if (normalized) {
      references.add(normalized);
    }
  }

  return [...references].sort();
}

function normalizeReferencePath(rawPath: string): string | undefined {
  const withoutDotPrefix = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  const withoutFragment = withoutDotPrefix.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
  const normalized = normalize(withoutQuery);

  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    normalized.startsWith("..") ||
    normalized === "references" ||
    !normalized.startsWith(`references${sep}`)
  ) {
    return undefined;
  }

  if (!SUPPORTED_REFERENCE_EXTENSIONS.has(extname(normalized).toLowerCase())) {
    return undefined;
  }

  return normalized;
}

function readReferenceDocument(
  skillDir: string,
  realSkillDir: string,
  referencePath: string,
): AgentSkillReferenceDocument | undefined {
  const candidatePath = resolve(skillDir, referencePath);
  if (!existsSync(candidatePath)) {
    return undefined;
  }

  const realReferencePath = realpathSync(candidatePath);
  const relativeFromSkillDir = relative(realSkillDir, realReferencePath);
  if (relativeFromSkillDir.startsWith("..") || isAbsolute(relativeFromSkillDir)) {
    return undefined;
  }

  if (!statSync(realReferencePath).isFile()) {
    return undefined;
  }

  return {
    relativePath: referencePath.split(sep).join("/"),
    path: realReferencePath,
    content: readFileSync(realReferencePath, "utf-8"),
  };
}
