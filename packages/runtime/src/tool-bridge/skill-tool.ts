import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { SKILL_TOOL_ID, type SkillLibrary } from "@roll-agent/core/skills/library";
import type { ToolRegistry } from "./naming.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";

export const SKILL_TOOL_AGENT_NAME = "roll";
export const SKILL_TOOL_NAME = "skill";
export { SKILL_TOOL_ID };

const MAX_SKILL_CONTENT_CHARS = 60_000;
const MAIN_SKILL_REFERENCE_ALIASES = new Set([
  "",
  ".",
  "./",
  "/",
  "skill.md",
  "./skill.md",
  "/skill.md",
]);

const skillToolInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .describe("要加载的 skill 名称（见 system prompt 中的 Skills 目录）"),
  reference: z
    .string()
    .optional()
    .describe(
      "仅在加载 references/ 下的文件时填写，如 references/workflows.md；加载主 SKILL.md 时省略此参数",
    ),
});

export type SkillToolInput = z.infer<typeof skillToolInputSchema>;

function clip(content: string): string {
  if (content.length <= MAX_SKILL_CONTENT_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_SKILL_CONTENT_CHARS)}\n\n[内容过长已截断，共 ${String(content.length)} 字符]`;
}

function normalizeSkillReference(reference: string | undefined): string | undefined {
  if (reference === undefined) {
    return undefined;
  }
  const normalized = reference.trim();
  return MAIN_SKILL_REFERENCE_ALIASES.has(normalized.toLowerCase()) ? undefined : normalized;
}

function withSkillLocation(skillRoot: string | undefined, content: string): string {
  if (skillRoot === undefined) {
    return content;
  }
  return [
    `SKILL_ROOT=${skillRoot}`,
    "这是该 skill 的 canonical absolute root。所有 scripts/、references/ 和其它相对路径必须相对 SKILL_ROOT 解析；执行脚本时将 workdir 设为 SKILL_ROOT，不要搜索其它 skill 目录。",
    "",
    content,
  ].join("\n");
}

function skillNotFoundResult(library: SkillLibrary, name: string): NormalizedToolResult {
  const available = library
    .list()
    .map((skill) => skill.name)
    .join(", ");
  return { output: `skill "${name}" 不存在。可用 skill: ${available}`, isError: true };
}

function loadSkill(library: SkillLibrary, name: string): NormalizedToolResult {
  const loaded = library.load(name);
  if (!loaded) {
    return skillNotFoundResult(library, name);
  }
  const referencesSection =
    loaded.referencePaths.length > 0
      ? `\n\n可用 references（传 reference 参数加载）:\n${loaded.referencePaths.map((path) => `- ${path}`).join("\n")}`
      : "";
  return {
    output: withSkillLocation(loaded.skillRoot, `${clip(loaded.content)}${referencesSection}`),
    isError: false,
  };
}

function loadSkillReference(
  library: SkillLibrary,
  name: string,
  referencePath: string,
): NormalizedToolResult {
  if (!library.list().some((skill) => skill.name === name)) {
    return skillNotFoundResult(library, name);
  }
  const referenceDocument =
    library.loadReferenceDocument === undefined
      ? undefined
      : library.loadReferenceDocument(name, referencePath);
  const content =
    library.loadReferenceDocument === undefined
      ? library.loadReference(name, referencePath)
      : referenceDocument?.content;
  if (content === undefined) {
    return {
      output: `skill "${name}" 中不存在 reference "${referencePath}"。加载主 SKILL.md 时请省略 reference；加载附加文档时仅支持 skill 目录内 references/ 下的文件。`,
      isError: true,
    };
  }
  return {
    output: withSkillLocation(referenceDocument?.skillRoot, clip(content)),
    isError: false,
  };
}

export function executeSkillTool(
  library: SkillLibrary,
  input: SkillToolInput,
): NormalizedToolResult {
  const reference = normalizeSkillReference(input.reference);
  return reference !== undefined
    ? loadSkillReference(library, input.name, reference)
    : loadSkill(library, input.name);
}

export function buildSkillToolset(
  library: SkillLibrary | (() => SkillLibrary),
  registry: ToolRegistry,
): ToolSet {
  const resolveLibrary = typeof library === "function" ? library : (): SkillLibrary => library;
  const id = registry.register(SKILL_TOOL_AGENT_NAME, SKILL_TOOL_NAME);
  return {
    [id]: tool({
      description:
        "加载 skill 主说明书时只传 name，不要传 reference；仅加载其 references/ 下的文件时才传 reference。执行涉及某个 skill 领域的任务前，先用它读取流程与约束。",
      inputSchema: skillToolInputSchema,
      execute: (input): NormalizedToolResult => executeSkillTool(resolveLibrary(), input),
    }),
  };
}
