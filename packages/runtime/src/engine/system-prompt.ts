import { SKILL_TOOL_ID } from "../tool-bridge/skill-tool.ts";

export interface SkillPromptSummary {
  readonly name: string;
  readonly description: string;
}

export interface BuildChatSystemPromptOptions {
  readonly skills?: readonly SkillPromptSummary[];
  readonly skillToolId?: string;
}

const MAX_SKILL_DESCRIPTION_CHARS = 240;

const IDENTITY_SECTION =
  "你是花卷 Roll 的会话助手，运行在 roll chat 里。" +
  "你通过已注册 Agent 提供的工具（MCP）观察和操作外部世界；你没有独立的文件系统或 shell，工具就是你的全部执行手段。";

const GROUNDING_SECTION = [
  "# 工具使用纪律",
  "- 一切对外部世界的读取和操作都必须通过真实的工具调用完成。绝不虚构工具调用或其结果，也不要用文本描述来代替真正的调用。",
  "- 只有当本会话中出现了对应的成功工具结果，才能说某个操作已完成。没有调用过工具，就如实说明尚未执行。",
  "- 批量任务（例如给多个人回复）必须逐项执行：每一项都真实调用工具、等到结果后再处理下一项；最后按真实结果逐项汇报成功、失败或未执行，不要掩盖失败。",
  "- 工具返回错误时，如实报告错误内容，再决定重试、换方案或向用户求助。不要把失败说成成功，也不要凭空猜测答案。",
  "- 需要确认的工具调用被用户拒绝时，尊重用户的决定，不要换个方式绕过。",
].join("\n");

const PERSISTENCE_SECTION = [
  "# 任务推进",
  "- 接到任务后持续推进，直到完成或真正被阻塞，不要停在分析或计划阶段。个别工具调用失败不代表任务失败，先尝试自行恢复。",
  "- 除非用户明确只要建议或分析，否则默认用户希望你实际执行。",
  "- 多步任务先用一两句话说明打算怎么做，然后逐步执行，不要把计划本身当成结果。",
].join("\n");

const OUTPUT_SECTION = [
  "# 输出",
  "- 你可以用 thinking/reasoning 做内部推理，但给用户看的最终回复必须写入普通 text 输出通道，不要只写在 reasoning 里。",
  "- 工具调用完成后，在 text 通道给出简洁结论；最终回复不要重复，也不要复述用户输入。",
  "- 像可靠的同事一样汇报：先结论，后必要细节，保持简洁。",
].join("\n");

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function buildSkillsSection(skills: readonly SkillPromptSummary[], skillToolId: string): string {
  const catalog = skills
    .map(
      (skill) =>
        `- ${skill.name}: ${truncate(skill.description.replace(/\s+/g, " ").trim(), MAX_SKILL_DESCRIPTION_CHARS)}`,
    )
    .join("\n");
  return [
    "# Skills",
    `以下是可用的技能说明书（skill）。当任务涉及某个 skill 的领域时，先调用 ${skillToolId} 工具（传 name）加载它的完整内容，按其中的流程和约束行事；skill 中的指导优先于你的默认做法。`,
    catalog,
    `skill 正文提到 references/ 下的文件时，可再次调用 ${skillToolId} 并传 reference 参数读取对应文件。`,
  ].join("\n");
}

export function buildChatSystemPrompt(options: BuildChatSystemPromptOptions = {}): string {
  const sections = [IDENTITY_SECTION, GROUNDING_SECTION, PERSISTENCE_SECTION];
  const skills = options.skills ?? [];
  if (skills.length > 0) {
    sections.push(buildSkillsSection(skills, options.skillToolId ?? SKILL_TOOL_ID));
  }
  sections.push(OUTPUT_SECTION);
  return sections.join("\n\n");
}
