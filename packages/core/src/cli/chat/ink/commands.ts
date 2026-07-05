export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/compact", description: "压缩上下文,释放 token" },
  { name: "/think", description: "开关 thinking/reasoning (on | off)" },
  { name: "/effort", description: "设置推理努力程度 (low | medium | high)" },
  { name: "/auto", description: "开关自动批准工具调用 (on | off)，Shift+Tab 快捷切换" },
  { name: "/help", description: "列出可用命令" },
  { name: "/exit", description: "退出对话" },
];

export function filterCommands(input: string): SlashCommand[] {
  const token = (input.split(/\s+/, 1)[0] ?? "").toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.toLowerCase().startsWith(token));
}
