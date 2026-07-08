import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OrchestratorSkillTarget {
  readonly id: string;
  readonly label: string;
  readonly userDir: string;
  readonly projectDir: string;
  readonly detectDir: string;
}

export const ORCHESTRATOR_SKILL_TARGETS = [
  {
    id: "claude-code",
    label: "Claude Code",
    userDir: "~/.claude/skills",
    projectDir: ".claude/skills",
    detectDir: "~/.claude",
  },
  {
    id: "codex",
    label: "Codex",
    userDir: "~/.codex/skills",
    projectDir: ".codex/skills",
    detectDir: "~/.codex",
  },
  {
    id: "agents",
    label: "通用 .agents 目录",
    userDir: "~/.agents/skills",
    projectDir: ".agents/skills",
    detectDir: "~/.agents",
  },
] as const satisfies readonly OrchestratorSkillTarget[];

export type OrchestratorTargetId = (typeof ORCHESTRATOR_SKILL_TARGETS)[number]["id"];

const TARGETS_BY_ID = Object.fromEntries(
  ORCHESTRATOR_SKILL_TARGETS.map((target) => [target.id, target]),
) as Readonly<Record<OrchestratorTargetId, OrchestratorSkillTarget>>;

export function isOrchestratorTargetId(value: string): value is OrchestratorTargetId {
  return value in TARGETS_BY_ID;
}

export interface DetectOrchestratorOptions {
  readonly home?: string;
  readonly cwd?: string;
  readonly project?: boolean;
}

export interface DetectedOrchestratorTarget {
  readonly target: OrchestratorSkillTarget;
  readonly present: boolean;
  readonly skillsDir: string;
}

function resolveHomePath(home: string, tildePath: string): string {
  return join(home, tildePath.replace(/^~\//, ""));
}

export function detectOrchestratorTargets(
  options: DetectOrchestratorOptions = {},
): readonly DetectedOrchestratorTarget[] {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  return ORCHESTRATOR_SKILL_TARGETS.map((target) => ({
    target,
    present: existsSync(resolveHomePath(home, target.detectDir)),
    skillsDir: options.project
      ? resolve(cwd, target.projectDir)
      : resolveHomePath(home, target.userDir),
  }));
}
