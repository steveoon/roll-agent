import { readdirSync, statSync } from "node:fs";
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
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionPlan,
} from "../tool-execution-coordinator.ts";
import { canonicalFileKey, resolveFilePath } from "./file-io.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const LIST_DIR_TOOL_NAME = "list_dir";

const MAX_ENTRIES = 300;

const listDirInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe("目录路径，相对当前工作目录或绝对路径，默认当前工作目录"),
});

export type ListDirInput = z.infer<typeof listDirInputSchema>;

const LIST_ANNOTATIONS = { readOnlyHint: true } as const;

function fileSizeSuffix(target: string): string {
  try {
    return `（${String(statSync(target).size)} 字节）`;
  } catch {
    return "";
  }
}

export function executeListDir(
  settings: ResolvedFileToolsSettings,
  input: ListDirInput,
): NormalizedToolResult {
  const path = resolveFilePath(settings.workdir, input.path ?? ".");
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, `目录不存在或不可读: ${path}`);
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  const shown = sorted.slice(0, MAX_ENTRIES);
  const lines = shown.map((entry) =>
    entry.isDirectory()
      ? `${entry.name}/`
      : `${entry.name}${fileSizeSuffix(resolve(path, entry.name))}`,
  );
  const parts = [`目录: ${path}`, lines.join("\n")];
  if (sorted.length > shown.length) {
    parts.push(`（仅显示前 ${String(MAX_ENTRIES)} 项（共 ${String(sorted.length)} 项））`);
  }
  return successfulToolResult(parts.join("\n"));
}

export function buildListDirTool(
  settings: ResolvedFileToolsSettings,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, LIST_DIR_TOOL_NAME, {
    annotations: LIST_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = listDirInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: path 须为非空字符串",
        );
      }
      return gateToolCall(
        ctx,
        FILE_TOOLS_AGENT_NAME,
        LIST_DIR_TOOL_NAME,
        parsed.data,
        LIST_ANNOTATIONS,
      );
    },
    resources: (rawInput) => {
      const parsed = listDirInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalFileKey(resolveFilePath(settings.workdir, parsed.data.path ?? "."))}`
        : `file-tools:${settings.workdir}`;
      return [{ key, mode: TOOL_RESOURCE_ACCESS_MODES.read }];
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description: "列出目录内容（目录带 / 后缀，文件附字节数）。默认列出当前工作目录。",
      inputSchema: listDirInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: ListDirInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          ctx.coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          () => Promise.resolve(executeListDir(settings, input)),
        ),
    }),
  };
}
