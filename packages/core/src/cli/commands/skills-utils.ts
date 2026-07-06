import { readFileSync } from "node:fs";
import type { RegisteredAgent } from "../../types/agent.ts";
import {
  readReferencedSkillDocuments,
  type SkillReferenceDocument,
} from "../../skills/documents.ts";
import { getAgentSkillPath, resolveAgentSkillPath } from "../../skills/library.ts";

export type SkillDocumentSource = "filesystem" | "registry";

export type AgentSkillReferenceDocument = SkillReferenceDocument;

export { getAgentSkillPath, resolveAgentSkillPath };

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
