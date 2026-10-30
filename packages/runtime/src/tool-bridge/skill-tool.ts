import { asSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import { SKILL_TOOL_ID, type SkillLibrary } from "../skills/contracts.ts";
import type { ToolRegistry } from "./naming.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "./normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionCoordinator,
  type ToolExecutionPlan,
} from "./tool-execution-coordinator.ts";

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

function skillModelInputSchema(names: readonly string[]) {
  return skillToolInputSchema.extend({
    name: z.enum(names).describe("从当前 Skills 目录选择名称并原样传入，不要附加说明文字"),
    reference: z
      .string()
      .nullable()
      .describe("读取主 SKILL.md 传 null；读取附加文档传 references/ 下的相对路径"),
  });
}

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

function skillNameEditDistance(input: readonly string[], candidate: readonly string[]): number {
  let previous = Array.from({ length: candidate.length + 1 }, (_, index) => index);
  let current = new Array<number>(candidate.length + 1).fill(0);
  for (const [inputIndex, inputChar] of input.entries()) {
    current[0] = inputIndex + 1;
    for (const [candidateIndex, candidateChar] of candidate.entries()) {
      const deletion = (previous[candidateIndex + 1] ?? Number.POSITIVE_INFINITY) + 1;
      const insertion = (current[candidateIndex] ?? Number.POSITIVE_INFINITY) + 1;
      const substitution =
        (previous[candidateIndex] ?? Number.POSITIVE_INFINITY) +
        (inputChar === candidateChar ? 0 : 1);
      current[candidateIndex + 1] = Math.min(deletion, insertion, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[candidate.length] ?? input.length;
}

function rankSkillNames(library: SkillLibrary, name: string): string[] {
  // Compare Unicode code points without removing meaningful suffixes or punctuation.
  const input = Array.from(name.trim());
  return library
    .list()
    .map((skill, index) => {
      const candidate = Array.from(skill.name);
      return {
        name: skill.name,
        index,
        distance: skillNameEditDistance(input, candidate),
        length: Math.max(input.length, candidate.length, 1),
      };
    })
    .sort(
      (left, right) =>
        left.distance * right.length - right.distance * left.length || left.index - right.index,
    )
    .map((skill) => skill.name);
}

function skillNotFoundResult(library: SkillLibrary, name: string): NormalizedToolResult {
  const availableNames = rankSkillNames(library, name);
  const error = {
    code: TOOL_OUTCOME_KINDS.invalidInput,
    field: "name",
    receivedName: name,
    message:
      "没有找到完全匹配的 skill。请结合当前任务，从 availableNames 中选择一个名称并原样传入。不要翻译、改写名称或附加说明文字，也不要原样重试此次失败的 name。",
    availableNamesOrder:
      "完整名称的标准化编辑距离由小到大排列，同分保持目录顺序；排序仅帮助查找，不代表该 skill 一定适合当前任务。",
    availableNames,
  };
  return failedToolResult(
    TOOL_OUTCOME_KINDS.invalidInput,
    `skill "${name}" 不存在。可用 skill: ${availableNames.join(", ")}`,
    // Keep the full catalog in the model projection, independently of display limits.
    { model: { type: "error-json", value: error } },
  );
}

/** Preserve actionable feedback when the SDK rejects a name before tool execution. */
export function skillInputErrorResult(
  library: SkillLibrary,
  input: unknown,
): NormalizedToolResult | undefined {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) return undefined;
  if (typeof parsed.name !== "string") return undefined;
  return library.list().some((skill) => skill.name === parsed.name)
    ? undefined
    : skillNotFoundResult(library, parsed.name);
}

function loadSkill(library: SkillLibrary, name: string): NormalizedToolResult {
  const loaded = library.load(name);
  if (!loaded) {
    return library.list().some((skill) => skill.name === name)
      ? failedToolResult(
          TOOL_OUTCOME_KINDS.toolFailed,
          `skill "${name}" 已发现，但主文档加载失败；请检查 SKILL.md 是否可读及格式是否有效`,
        )
      : skillNotFoundResult(library, name);
  }
  const referencesSection =
    loaded.referencePaths.length > 0
      ? `\n\n可用 references（传 reference 参数加载）:\n${loaded.referencePaths.map((path) => `- ${path}`).join("\n")}`
      : "";
  return successfulToolResult(
    withSkillLocation(loaded.skillRoot, `${clip(loaded.content)}${referencesSection}`),
  );
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
    return failedToolResult(
      TOOL_OUTCOME_KINDS.invalidInput,
      `skill "${name}" 中不存在 reference "${referencePath}"。加载主 SKILL.md 时请省略 reference；加载附加文档时仅支持 skill 目录内 references/ 下的文件。`,
    );
  }
  return successfulToolResult(withSkillLocation(referenceDocument?.skillRoot, clip(content)));
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
  coordinator?: ToolExecutionCoordinator,
  options: { readonly toolId?: string; readonly names?: readonly string[] } = {},
): ToolSet {
  const resolveLibrary = typeof library === "function" ? library : (): SkillLibrary => library;
  const names =
    options.names ??
    resolveLibrary()
      .list()
      .map((skill) => skill.name);
  if (names.length === 0) return {};
  const id = options.toolId ?? registry.register(SKILL_TOOL_AGENT_NAME, SKILL_TOOL_NAME);
  const plan: ToolExecutionPlan = {
    resources: () => [{ key: "skill-library", mode: TOOL_RESOURCE_ACCESS_MODES.read }],
  };
  coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        "按目录中的完整名称加载 skill。读取主说明书时 reference 传 null；读取 references/ 下的文件时传相对路径。执行涉及某个 skill 领域的任务前，先用它读取流程与约束。",
      inputSchema: asSchema(skillModelInputSchema(names)),
      strict: true,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          () =>
            Promise.resolve(
              executeSkillTool(resolveLibrary(), {
                name: input.name,
                ...(input.reference === null ? {} : { reference: input.reference }),
              }),
            ),
        ),
    }),
  };
}
