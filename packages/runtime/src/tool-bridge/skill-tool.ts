import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { SKILL_TOOL_ID, type SkillLibrary } from "@roll-agent/core/skills/library";
import type { ToolRegistry } from "./naming.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";

export const SKILL_TOOL_AGENT_NAME = "roll";
export const SKILL_TOOL_NAME = "skill";
export { SKILL_TOOL_ID };

const MAX_SKILL_CONTENT_CHARS = 60_000;

const skillToolInputSchema = z.object({
  name: z.string().min(1).describe("要加载的 skill 名称（见 system prompt 中的 Skills 目录）"),
  reference: z
    .string()
    .min(1)
    .optional()
    .describe(
      "可选：加载该 skill 的 references/ 下的某个文件，传相对路径如 references/workflows.md",
    ),
});

export type SkillToolInput = z.infer<typeof skillToolInputSchema>;

function clip(content: string): string {
  if (content.length <= MAX_SKILL_CONTENT_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_SKILL_CONTENT_CHARS)}\n\n[内容过长已截断，共 ${String(content.length)} 字符]`;
}

function loadSkill(library: SkillLibrary, name: string): NormalizedToolResult {
  const loaded = library.load(name);
  if (!loaded) {
    const available = library
      .list()
      .map((skill) => skill.name)
      .join(", ");
    return { output: `skill "${name}" 不存在。可用 skill: ${available}`, isError: true };
  }
  const referencesSection =
    loaded.referencePaths.length > 0
      ? `\n\n可用 references（传 reference 参数加载）:\n${loaded.referencePaths.map((path) => `- ${path}`).join("\n")}`
      : "";
  return { output: `${clip(loaded.content)}${referencesSection}`, isError: false };
}

function loadSkillReference(
  library: SkillLibrary,
  name: string,
  referencePath: string,
): NormalizedToolResult {
  const content = library.loadReference(name, referencePath);
  if (content === undefined) {
    return {
      output: `skill "${name}" 中不存在 reference "${referencePath}"（仅支持 skill 目录内 references/ 下的文件）`,
      isError: true,
    };
  }
  return { output: clip(content), isError: false };
}

export function executeSkillTool(
  library: SkillLibrary,
  input: SkillToolInput,
): NormalizedToolResult {
  return input.reference !== undefined
    ? loadSkillReference(library, input.name, input.reference)
    : loadSkill(library, input.name);
}

export function buildSkillToolset(library: SkillLibrary, registry: ToolRegistry): ToolSet {
  const id = registry.register(SKILL_TOOL_AGENT_NAME, SKILL_TOOL_NAME);
  return {
    [id]: tool({
      description:
        "加载一个 skill（技能说明书）的完整内容，或其 references/ 下的文件。执行涉及某个 skill 领域的任务前，先用它读取流程与约束。",
      inputSchema: skillToolInputSchema,
      execute: (input): NormalizedToolResult => executeSkillTool(library, input),
    }),
  };
}
