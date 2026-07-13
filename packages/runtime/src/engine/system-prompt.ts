import { SKILL_TOOL_ID } from "../tool-bridge/skill-tool.ts";

export interface SkillPromptSummary {
  readonly name: string;
  readonly description: string;
}

export interface SessionExecToolIds {
  readonly command: string;
  readonly poll: string;
  readonly list: string;
}

export interface AgentOnboardingCatalogEntry {
  readonly shortName: string;
  readonly description: string;
}

export interface AgentOnboardingPromptInfo {
  readonly installToolId: string;
  readonly catalog: readonly AgentOnboardingCatalogEntry[];
}

export interface BuildChatSystemPromptOptions {
  readonly skills?: readonly SkillPromptSummary[];
  readonly skillToolId?: string;
  readonly bashToolId?: string;
  readonly shellToolId?: string;
  readonly shellHints?: readonly string[];
  readonly sessionExecToolIds?: SessionExecToolIds;
  readonly agentCount?: number;
  readonly agentOnboarding?: AgentOnboardingPromptInfo;
}

const MAX_SKILL_DESCRIPTION_CHARS = 240;

const IDENTITY_PREFIX = "你是花卷 Roll 的会话助手，运行在 roll chat 里。";

function identitySection(hasShell: boolean): string {
  const tail = hasShell
    ? "你通过已注册 Agent 提供的工具（MCP）观察和操作外部世界，并有一个内建 shell 工具可以在本机执行命令。"
    : "你通过已注册 Agent 提供的工具（MCP）观察和操作外部世界；你没有独立的文件系统或 shell，工具就是你的全部执行手段。";
  return IDENTITY_PREFIX + tail;
}

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
    `加载结果中的 SKILL_ROOT 是该 skill 的 canonical absolute root。正文里的 scripts/、references/ 等相对路径一律相对 SKILL_ROOT 解析；执行脚本时把 workdir 设为 SKILL_ROOT，不要再搜索 .roll、.claude、.agents 或其它目录猜路径。`,
    `skill 正文提到 references/ 下的文件时，可再次调用 ${skillToolId} 并传 reference 参数读取对应文件。`,
  ].join("\n");
}

function buildAgentOnboardingSection(info: AgentOnboardingPromptInfo): string {
  const catalog = info.catalog
    .map(
      (entry) =>
        `- ${entry.shortName}: ${truncate(entry.description.replace(/\s+/g, " ").trim(), MAX_SKILL_DESCRIPTION_CHARS)}`,
    )
    .join("\n");
  return [
    "# Agent 安装",
    "当前没有任何已注册的子 Agent，对外部系统的操作能力受限。可安装的官方 Agent：",
    catalog,
    `当用户的需求涉及上述 Agent 的能力时，先说明它的用途并征得用户同意，再调用 ${info.installToolId} 安装（安装会执行 npm install，用户还需在界面上二次确认）。新 Agent 的工具从下一轮对话开始可用。`,
    "绝不在用户未明确同意的情况下自行安装。",
  ].join("\n");
}

function buildShellSection(
  shellToolId: string,
  sessionExec: SessionExecToolIds | undefined,
  shellHints: readonly string[],
): string {
  const longRunningLines = sessionExec
    ? [
        `- 预计跑几十秒以上的命令（构建、批处理脚本）不要用 ${shellToolId}（会被单轮超时杀掉），改用 ${sessionExec.command} 后台执行。`,
        `- ${sessionExec.command} 未结束时会返回 session_id；用 ${sessionExec.poll}（chars 留空）轮询进度直到拿到退出码，需要中断时 chars 传 "\\u0003"。`,
        `- 如果一轮因超时或上下文丢失而没有拿到 session_id，下一轮先用 ${sessionExec.list} 找回会话，再用 ${sessionExec.poll} 继续；用户取消会中断本轮触达的会话，只能查看终态结果，不应宣称仍在运行。`,
      ]
    : ["- 预计耗时较长的命令（如构建、脚本）要显式调大 timeout_ms。"];
  return [
    "# Shell 工具",
    `- 需要在本机执行命令时调用 ${shellToolId}；用 workdir 参数指定工作目录，不要在 command 里用 cd。`,
    ...shellHints.map((hint) => `- ${hint}`),
    "- 输出会被截断，优先用精确过滤或预览命令，而不是全量 dump 大文件。",
    "- 优先使用只读命令；有副作用或破坏性的命令可能需要用户确认，被拒绝时不要绕过。",
    ...longRunningLines,
  ].join("\n");
}

export function buildChatSystemPrompt(options: BuildChatSystemPromptOptions = {}): string {
  const shellToolId = options.shellToolId ?? options.bashToolId;
  const sections = [
    identitySection(shellToolId !== undefined),
    GROUNDING_SECTION,
    PERSISTENCE_SECTION,
  ];
  if (
    options.agentCount === 0 &&
    options.agentOnboarding !== undefined &&
    options.agentOnboarding.catalog.length > 0
  ) {
    sections.push(buildAgentOnboardingSection(options.agentOnboarding));
  }
  const skills = options.skills ?? [];
  if (skills.length > 0) {
    sections.push(buildSkillsSection(skills, options.skillToolId ?? SKILL_TOOL_ID));
  }
  if (shellToolId !== undefined) {
    sections.push(
      buildShellSection(shellToolId, options.sessionExecToolIds, options.shellHints ?? []),
    );
  }
  sections.push(OUTPUT_SECTION);
  return sections.join("\n\n");
}
