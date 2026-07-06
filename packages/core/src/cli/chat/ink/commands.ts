import { SKILL_TOOL_ID } from "../../../skills/library.ts";
import { displayWidth } from "./markdown.ts";

export interface SlashCommand {
  readonly kind: "command";
  readonly name: string;
  readonly description: string;
}

export interface SlashSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

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
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  let out = "";
  let width = 0;
  for (const ch of text) {
    const chWidth = displayWidth(ch);
    if (width + chWidth > maxWidth - 1) {
      break;
    }
    out += ch;
    width += chWidth;
  }
  return `${out}…`;
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

export function findSkillBySlashName(
  token: string,
  skills: readonly SlashSkillSummary[],
): SlashSkillSummary | undefined {
  const normalized = token.toLowerCase();
  return skills.find((skill) => skillSlashName(skill.name).toLowerCase() === normalized);
}

export interface SkillInvocation {
  readonly skills: readonly SlashSkillSummary[];
  readonly prompt: string;
}

export function parseSkillInvocation(
  input: string,
  skills: readonly SlashSkillSummary[],
): SkillInvocation | undefined {
  let rest = input.trimStart();
  const selected: SlashSkillSummary[] = [];
  const seen = new Set<string>();
  while (true) {
    const match = /^(\/\S+)(\s*)/.exec(rest);
    if (!match) {
      break;
    }
    const skill = findSkillBySlashName(match[1] ?? "", skills);
    if (!skill) {
      break;
    }
    if (!seen.has(skill.name)) {
      selected.push(skill);
      seen.add(skill.name);
    }
    rest = rest.slice(match[0].length);
  }
  if (selected.length === 0) {
    return undefined;
  }
  return {
    skills: selected,
    prompt: rest.trim(),
  };
}

export function buildSkillInvocationPrompt(invocation: SkillInvocation): string {
  const names = invocation.skills.map((skill) => `- ${skill.name}`).join("\n");
  return [
    `请先调用 \`${SKILL_TOOL_ID}\` 工具加载以下 skill，并严格按它们的说明处理后续请求：`,
    names,
    "",
    "用户请求：",
    invocation.prompt,
  ].join("\n");
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
