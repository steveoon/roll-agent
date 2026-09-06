import {
  findSkillBySlashName,
  isSlashCommandShaped,
  isSlashCommandToken,
  parseSkillInvocation,
  type SkillInvocation,
  type SkillInvocationSummary,
} from "../../../skills/invocation.ts";
import { displayWidth } from "./display-width.ts";

export { findSkillBySlashName, isSlashCommandShaped, isSlashCommandToken, parseSkillInvocation };
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
    name: "/model",
    description: "切换本次对话的 LLM（provider/model），可选设为默认",
  },
  {
    kind: "command",
    name: "/show-think",
    description: "完整显示或折叠已完成的思考 (on | off)，不带参数时切换",
  },
  {
    kind: "command",
    name: "/diff",
    description: "完整显示或折叠大段文件 diff (on | off)，不带参数时切换",
  },
  {
    kind: "command",
    name: "/auto",
    description: "开关自动批准工具调用 (on | off)，Shift+Tab 快捷切换",
  },
  { kind: "command", name: "/skills", description: "列出可加载的 SKILL" },
  { kind: "command", name: "/resume", description: "切换到已有会话" },
  { kind: "command", name: "/schedule", description: "查看定时任务及历次执行记录" },
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

function rankSlashMatches<T extends { readonly name: string }>(
  input: string,
  entries: readonly T[],
): T[] {
  const token = currentSlashToken(input).toLowerCase().replace(/^\//, "");
  const prefixMatches: T[] = [];
  const substringMatches: T[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase().slice(1);
    if (name.startsWith(token)) {
      prefixMatches.push(entry);
    } else if (token.length > 0 && name.includes(token)) {
      substringMatches.push(entry);
    }
  }
  return [...prefixMatches, ...substringMatches];
}

export function filterSlashEntries(
  input: string,
  skills: readonly SlashSkillSummary[] = [],
): SlashEntry[] {
  return rankSlashMatches(input, [...SLASH_COMMANDS, ...buildSkillEntries(skills)]);
}

export function filterCommands(input: string): SlashCommand[] {
  return rankSlashMatches(input, SLASH_COMMANDS);
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
