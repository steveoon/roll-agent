import {
  findSkillBySlashName,
  parseSkillInvocation,
  type SkillInvocation,
  type SkillInvocationSummary,
} from "../../../skills/invocation.ts";
import { displayWidth } from "./display-width.ts";

export { findSkillBySlashName, parseSkillInvocation };
export type { SkillInvocation };

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ELLIPSIS = "…";

export interface SlashCommand {
  readonly kind: "command";
  readonly name: string;
  readonly description: string;
}

export type SlashSkillSummary = SkillInvocationSummary;

export interface SlashSkillEntry {
  readonly kind: "skill";
  readonly name: string;
  readonly description: string;
  readonly skillName: string;
  readonly source: string;
}

export type SlashEntry = SlashCommand | SlashSkillEntry;

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { kind: "command", name: "/compact", description: "压缩上下文,释放 token" },
  { kind: "command", name: "/think", description: "开关 thinking/reasoning (on | off)" },
  { kind: "command", name: "/effort", description: "设置推理努力程度 (low | medium | high)" },
  {
    kind: "command",
    name: "/auto",
    description: "开关自动批准工具调用 (on | off)，Shift+Tab 快捷切换",
  },
  { kind: "command", name: "/skills", description: "列出可加载的 SKILL" },
  { kind: "command", name: "/help", description: "列出可用命令" },
  { kind: "command", name: "/exit", description: "退出对话" },
];

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateDisplay(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  const contentWidth = maxWidth - displayWidth(ELLIPSIS);
  let out = "";
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = displayWidth(segment);
    if (width + segmentWidth > contentWidth) {
      break;
    }
    out += segment;
    width += segmentWidth;
  }
  return `${out}${ELLIPSIS}`;
}

export function skillSlashName(skillName: string): string {
  return `/${skillName}`;
}

export function buildSkillEntries(skills: readonly SlashSkillSummary[]): SlashSkillEntry[] {
  return [...skills]
    .filter(
      (skill) => !SLASH_COMMANDS.some((command) => command.name === skillSlashName(skill.name)),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => {
      const description = collapse(skill.description);
      return {
        kind: "skill",
        name: skillSlashName(skill.name),
        skillName: skill.name,
        source: skill.source,
        description: description.length > 0 ? `${skill.source} · ${description}` : skill.source,
      };
    });
}

export function currentSlashToken(input: string): string {
  const tokens = input.split(/\s+/);
  const last = tokens.at(-1) ?? "";
  if (last.startsWith("/")) {
    return last;
  }
  return tokens[0] ?? "";
}

export function filterSlashEntries(
  input: string,
  skills: readonly SlashSkillSummary[] = [],
): SlashEntry[] {
  const token = currentSlashToken(input).toLowerCase();
  return [...SLASH_COMMANDS, ...buildSkillEntries(skills)].filter((entry) =>
    entry.name.toLowerCase().startsWith(token),
  );
}

export function filterCommands(input: string): SlashCommand[] {
  const token = currentSlashToken(input).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.toLowerCase().startsWith(token));
}

const SKILL_LIST_DEFAULT_WIDTH = 96;

export function buildSkillListLines(
  skills: readonly SlashSkillSummary[],
  width: number = SKILL_LIST_DEFAULT_WIDTH,
): string[] {
  if (skills.length === 0) {
    return ["当前没有可加载的 SKILL。"];
  }
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.min(
    Math.max(...sorted.map((skill) => skillSlashName(skill.name).length)),
    28,
  );
  return [
    `可加载 SKILL（${String(sorted.length)} 个）· 用法: /<skill-name> 你的请求`,
    ...sorted.map((skill) => {
      const name = skillSlashName(skill.name).padEnd(nameWidth);
      const line = `  ${name}  [${skill.source}] ${collapse(skill.description)}`;
      return truncateDisplay(line, Math.max(width, 40));
    }),
  ];
}

export function formatSkillList(
  skills: readonly SlashSkillSummary[],
  width: number = SKILL_LIST_DEFAULT_WIDTH,
): string {
  return buildSkillListLines(skills, width).join("\n");
}
