import { statSync } from "node:fs";
import { resolve } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolRegistry } from "../naming.ts";
import type { ToolBridgeContext } from "../build-tools.ts";
import { gateToolCall } from "../build-tools.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import {
  OPAQUE_SIDE_EFFECT_RESOURCE,
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionPlan,
} from "../tool-execution-coordinator.ts";
import {
  canonicalResourcePath,
  captureFilePathAdmission,
  escapesWorkdir,
  resolveFilePath,
  revalidateFilePathAdmission,
} from "./file-io.ts";
import { runRg } from "./rg-exec.ts";
import { gateExternalPath } from "./external-approval.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const GLOB_TOOL_NAME = "glob";

const MAX_RESULTS = 200;
const RG_TRUNCATED_NOTICE =
  "ripgrep 输出过多已被截断，文件列表可能不完整，请缩小 path 或使用更精确的 pattern";

const globInputSchema = z.object({
  pattern: z.string().min(1).describe('文件名 glob，如 "**/*.md" 或 "src/**/config.*"'),
  path: z.string().min(1).optional().describe("起始目录，相对当前工作目录或绝对路径，默认工作目录"),
});

export type GlobInput = z.infer<typeof globInputSchema>;

const GLOB_ANNOTATIONS = { readOnlyHint: true } as const;

function buildRgArgs(pattern: string, resolvedPath: string): string[] {
  return ["--files", "--glob", pattern, resolvedPath];
}

interface StatEntry {
  readonly path: string;
  readonly mtimeMs: number;
}

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function sortByMtimeDescending(paths: readonly string[]): string[] {
  const entries: StatEntry[] = paths.map((path) => ({ path, mtimeMs: statMtimeMs(path) }));
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      if (right.entry.mtimeMs !== left.entry.mtimeMs) {
        return right.entry.mtimeMs - left.entry.mtimeMs;
      }
      return left.index - right.index;
    })
    .map(({ entry }) => entry.path);
}

function truncationNotice(total: number, rgTruncated: boolean): string | undefined {
  if (total > MAX_RESULTS) {
    return `共 ${String(total)} 个文件，仅显示前 200 个（按修改时间倒序）`;
  }
  return rgTruncated ? RG_TRUNCATED_NOTICE : undefined;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function executeGlob(
  settings: ResolvedFileToolsSettings,
  input: GlobInput,
  abortSignal?: AbortSignal,
): Promise<NormalizedToolResult> {
  const resolvedPath = resolveFilePath(settings.workdir, input.path ?? ".");
  if (isRegularFile(resolvedPath)) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.invalidInput,
      `${resolvedPath} 是文件而非目录：读取内容用 roll__read_file，按 pattern 找文件请把 path 设为起始目录`,
    );
  }
  const result = await runRg(buildRgArgs(input.pattern, resolvedPath), settings.workdir, {
    ...(abortSignal ? { abortSignal } : {}),
  });
  if (result.cancelled === true) {
    return failedToolResult(TOOL_OUTCOME_KINDS.cancelled, "已取消");
  }
  if (!result.ok) {
    return failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, result.errorMessage ?? "rg 执行失败");
  }
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    return successfulToolResult(`未找到匹配 ${input.pattern} 的文件。`);
  }
  const absolutePaths = lines.map((line) => resolve(settings.workdir, line));
  const sorted = sortByMtimeDescending(absolutePaths);
  const visible = sorted.slice(0, MAX_RESULTS);
  const parts = [visible.join("\n")];
  const notice = truncationNotice(sorted.length, result.truncated);
  if (notice !== undefined) {
    parts.push(notice);
  }
  return successfulToolResult(parts.join("\n\n"));
}

export function buildGlobTool(
  settings: ResolvedFileToolsSettings,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, GLOB_TOOL_NAME, {
    annotations: GLOB_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = globInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: pattern 必须为非空字符串，path 须为非空字符串",
        );
      }
      if (escapesWorkdir(settings.workdir, parsed.data.path ?? ".")) {
        const gated = await gateExternalPath(ctx, GLOB_TOOL_NAME, parsed.data, id);
        if (gated !== undefined) {
          return gated;
        }
      }
      return gateToolCall(
        ctx,
        FILE_TOOLS_AGENT_NAME,
        GLOB_TOOL_NAME,
        parsed.data,
        GLOB_ANNOTATIONS,
      );
    },
    resources: (rawInput) => {
      const parsed = globInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalResourcePath(resolveFilePath(settings.workdir, parsed.data.path ?? "."))}`
        : `file-tools:${settings.workdir}`;
      return [
        { key: OPAQUE_SIDE_EFFECT_RESOURCE, mode: TOOL_RESOURCE_ACCESS_MODES.read },
        { key, mode: TOOL_RESOURCE_ACCESS_MODES.read },
      ];
    },
    captureExecutionState: (rawInput) => {
      const parsed = globInputSchema.safeParse(rawInput);
      return parsed.success
        ? captureFilePathAdmission(settings.workdir, parsed.data.path ?? ".")
        : undefined;
    },
    revalidateExecution: (rawInput, capturedState) => {
      const parsed = globInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return undefined;
      }
      return revalidateFilePathAdmission(settings.workdir, parsed.data.path ?? ".", capturedState);
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        '按文件名 glob 模式查找文件（如 "**/*.md"、"src/**/config.*"），结果按修改时间倒序排列，最多返回 200 条。默认在当前工作目录递归查找，可用 path 指定起始目录。',
      inputSchema: globInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: GlobInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          ctx.coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          () => executeGlob(settings, input, options.abortSignal),
        ),
    }),
  };
}
