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
import { canonicalFileKey, escapesWorkdir, loadTextFile, resolveFilePath } from "./file-io.ts";
import type { FileStateTracker } from "./file-state-tracker.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const READ_FILE_TOOL_NAME = "read_file";

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_CHARS = 1000;

const readFileInputSchema = z.object({
  path: z.string().min(1).describe("要读取的文件路径，相对当前工作目录或绝对路径"),
  offset: z.number().int().min(1).optional().describe("起始行号（从 1 开始），默认 1"),
  limit: z.number().int().min(1).optional().describe("最多返回的行数，默认 2000"),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

const READ_ANNOTATIONS = { readOnlyHint: true } as const;

function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[行截断]` : line;
}

export function executeReadFile(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  input: ReadFileInput,
): NormalizedToolResult {
  const path = resolveFilePath(settings.workdir, input.path);
  const loaded = loadTextFile(path, { maxFileBytes: settings.maxFileBytes });
  if (!loaded.ok) {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, loaded.message);
  }
  const lines = loaded.content.split("\n");
  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_LINE_LIMIT;
  if (offset > lines.length) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.invalidInput,
      `offset ${String(offset)} 超出文件行数（共 ${String(lines.length)} 行）`,
    );
  }
  tracker.recordKnownContent(loaded.key, loaded.content);
  const slice = lines.slice(offset - 1, offset - 1 + limit).map(clipLine);
  let body = renderNumberedLines(slice, offset);
  if (body.length > settings.maxOutputChars) {
    const cut = body.lastIndexOf("\n", settings.maxOutputChars);
    body = body.slice(0, cut > 0 ? cut : settings.maxOutputChars);
  }
  const shownLines = body.length === 0 ? 0 : body.split("\n").length;
  const nextLine = offset + shownLines;
  const parts = [`文件: ${path}（共 ${String(lines.length)} 行）`, body];
  if (loaded.suspectEncoding) {
    parts.push("警告：内容含替换字符，文件可能不是 UTF-8 编码。");
  }
  if (nextLine <= lines.length) {
    parts.push(
      `（未展示全部内容，从第 ${String(nextLine)} 行继续，设置 offset: ${String(nextLine)}）`,
    );
  }
  return successfulToolResult(parts.join("\n"));
}

export function buildReadFileTool(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, READ_FILE_TOOL_NAME, {
    annotations: READ_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = readFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: path 必须为非空字符串，offset/limit 须为正整数",
        );
      }
      if (escapesWorkdir(settings.workdir, parsed.data.path)) {
        const approval = await ctx.requestApproval({
          agentName: FILE_TOOLS_AGENT_NAME,
          toolName: READ_FILE_TOOL_NAME,
          input: parsed.data,
          reason: "读取工作目录以外的文件",
        });
        if (!approval.approved) {
          return failedToolResult(
            TOOL_OUTCOME_KINDS.userRejected,
            `已取消执行${approval.reason ? `: ${approval.reason}` : ""}`,
            approval.reason ? { reason: approval.reason } : {},
          );
        }
      }
      return gateToolCall(
        ctx,
        FILE_TOOLS_AGENT_NAME,
        READ_FILE_TOOL_NAME,
        parsed.data,
        READ_ANNOTATIONS,
      );
    },
    resources: (rawInput) => {
      const parsed = readFileInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalFileKey(resolveFilePath(settings.workdir, parsed.data.path))}`
        : `file-tools:${settings.workdir}`;
      return [{ key, mode: TOOL_RESOURCE_ACCESS_MODES.read }];
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        '读取文本文件内容。输出每行带行号前缀（如 "   12→"），前缀不是文件内容。编辑文件前必须先用本工具读取。',
      inputSchema: readFileInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: ReadFileInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          ctx.coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          () => Promise.resolve(executeReadFile(settings, tracker, input)),
        ),
    }),
  };
}
