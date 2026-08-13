import { basename } from "node:path";
import { statSync } from "node:fs";
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
import { renderNumberedLines } from "./match-pipeline.ts";
import { canonicalFileKey, loadTextFile, resolveFilePath, saveTextFile } from "./file-io.ts";
import { FILE_FRESHNESS, type FileStateTracker } from "./file-state-tracker.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const WRITE_FILE_TOOL_NAME = "write_file";

const PREVIEW_LINES = 10;

const writeFileInputSchema = z.object({
  file_path: z.string().min(1).describe("要写入的文件路径，相对当前工作目录或绝对路径"),
  content: z.string().describe("完整的文件内容（整文件写入，覆盖原有内容）"),
});

export type WriteFileInput = z.infer<typeof writeFileInputSchema>;

const WRITE_ANNOTATIONS = {} as const;

function existsAsFile(path: string): boolean | "directory" {
  try {
    return statSync(path).isDirectory() ? "directory" : true;
  } catch {
    return false;
  }
}

export function executeWriteFile(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  input: WriteFileInput,
): NormalizedToolResult {
  const path = resolveFilePath(settings.workdir, input.file_path);
  const existing = existsAsFile(path);
  if (existing === "directory") {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, `${path} 是目录，不能作为文件写入`);
  }
  if (existing === true) {
    const loaded = loadTextFile(path, { maxFileBytes: settings.maxFileBytes });
    if (!loaded.ok) {
      return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, loaded.message);
    }
    const freshness = tracker.checkFreshness(loaded.key, loaded.content);
    if (freshness === FILE_FRESHNESS.unread) {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.toolFailed,
        `${path} 已存在。覆盖前请先用 roll__read_file 读取并确认现有内容；若只改部分内容，优先用 roll__edit_file。`,
      );
    }
    if (freshness === FILE_FRESHNESS.stale) {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.toolFailed,
        `${path} 在你上次读取后已被修改（可能是用户或其他程序改动）。请重新 roll__read_file 确认最新内容后再决定是否覆盖。`,
      );
    }
  }
  saveTextFile(path, input.content, false);
  tracker.recordKnownContent(canonicalFileKey(path), input.content);
  const lines = input.content.split("\n");
  const preview = renderNumberedLines(lines.slice(0, PREVIEW_LINES), 1);
  const parts = [
    `已写入 ${path}（${String(lines.length)} 行，${String(Buffer.byteLength(input.content, "utf8"))} 字节）：`,
    preview,
  ];
  if (lines.length > PREVIEW_LINES) {
    parts.push(`（预览前 ${String(PREVIEW_LINES)} 行）`);
  }
  return successfulToolResult(parts.join("\n"));
}

export function buildWriteFileTool(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, WRITE_FILE_TOOL_NAME, {
    annotations: WRITE_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = writeFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: file_path 必须为非空字符串，content 必须为字符串",
        );
      }
      const path = resolveFilePath(settings.workdir, parsed.data.file_path);
      return gateToolCall(
        ctx,
        FILE_TOOLS_AGENT_NAME,
        WRITE_FILE_TOOL_NAME,
        parsed.data,
        WRITE_ANNOTATIONS,
        {
          explanation: `写入 ${basename(path)}（${String(parsed.data.content.split("\n").length)} 行）`,
        },
      );
    },
    resources: (rawInput) => {
      const parsed = writeFileInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalFileKey(resolveFilePath(settings.workdir, parsed.data.file_path))}`
        : `file-tools:${settings.workdir}`;
      return [{ key, mode: TOOL_RESOURCE_ACCESS_MODES.write }];
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        "新建文件或整文件重写。已存在的文件必须先 roll__read_file 读取确认后才能覆盖；只改部分内容时优先用 roll__edit_file。",
      inputSchema: writeFileInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: WriteFileInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          ctx.coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          () => Promise.resolve(executeWriteFile(settings, tracker, input)),
        ),
    }),
  };
}
