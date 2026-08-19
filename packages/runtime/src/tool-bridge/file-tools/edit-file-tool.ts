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
import { lineNumberAt, renderNumberedLines } from "./match-pipeline.ts";
import {
  canonicalResourcePath,
  captureFilePathAdmission,
  escapesWorkdir,
  formatPathForApproval,
  loadTextFile,
  resolveFilePath,
  revalidateFilePathAdmission,
  saveTextFile,
  type LoadedTextFile,
} from "./file-io.ts";
import { rejectInvalidTextPayload } from "./control-chars.ts";
import { FILE_FRESHNESS, type FileStateTracker } from "./file-state-tracker.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";
import { planEdits, type AppliedEdit } from "./edit-plan.ts";

export const EDIT_FILE_TOOL_NAME = "edit_file";

const SNAPSHOT_RADIUS = 3;

const editEntrySchema = z.object({
  old_string: z
    .string()
    .min(1)
    .describe("要替换的原文，必须逐字复制自 read_file 读到的内容（不含行号前缀）"),
  new_string: z.string().describe("替换后的新内容，必须与 old_string 不同"),
  replace_all: z.boolean().optional().describe("替换所有精确匹配处，默认 false（要求唯一匹配）"),
});

const editFileInputSchema = z.object({
  file_path: z.string().min(1).describe("要修改的文件路径，相对当前工作目录或绝对路径"),
  edits: z.array(editEntrySchema).min(1).describe("按顺序应用的编辑列表；任何一条失败则整体不写入"),
});

export type EditFileInput = z.infer<typeof editFileInputSchema>;

const EDIT_ANNOTATIONS = {} as const;

function renderEditSuccess(
  path: string,
  content: string,
  applied: readonly AppliedEdit[],
  maxOutputChars: number,
): string {
  const lines = content.split("\n");
  const parts = [`已完成 ${String(applied.length)} 处修改并写入 ${path}：`];
  applied.forEach((record, index) => {
    const startLineNo = lineNumberAt(content, record.position);
    const endOffset = record.position + Math.max(record.length - 1, 0);
    const endLineNo = lineNumberAt(content, Math.min(endOffset, Math.max(content.length - 1, 0)));
    const windowStart = Math.max(1, startLineNo - SNAPSHOT_RADIUS);
    const windowEnd = Math.min(lines.length, endLineNo + SNAPSHOT_RADIUS);
    parts.push(`[${String(index + 1)}] 第 ${String(startLineNo)} 行附近：`);
    parts.push(renderNumberedLines(lines.slice(windowStart - 1, windowEnd), windowStart));
  });
  const rendered = parts.join("\n");
  return rendered.length > maxOutputChars
    ? `${rendered.slice(0, maxOutputChars)}\n…（快照过长已截断，修改均已写入）`
    : rendered;
}

function rejectInvalidEditPayloads(input: EditFileInput): NormalizedToolResult | undefined {
  for (const [index, edit] of input.edits.entries()) {
    const label = `第 ${String(index + 1)} 条编辑（共 ${String(input.edits.length)} 条）的`;
    const oldRejected = rejectInvalidTextPayload(`${label} old_string`, edit.old_string);
    if (oldRejected !== undefined) {
      return oldRejected;
    }
    const newRejected = rejectInvalidTextPayload(`${label} new_string`, edit.new_string);
    if (newRejected !== undefined) {
      return newRejected;
    }
  }
  return undefined;
}

function editFreshnessGuard(
  tracker: FileStateTracker,
  path: string,
  loaded: LoadedTextFile,
): NormalizedToolResult | undefined {
  const freshness = tracker.checkFreshness(loaded.key, loaded.content);
  if (freshness === FILE_FRESHNESS.unread) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.toolFailed,
      `尚未读取过 ${path}。请先用 roll__read_file 读取文件，再基于读到的内容编辑。`,
    );
  }
  if (freshness === FILE_FRESHNESS.stale) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.toolFailed,
      `${path} 在你上次读取后已被修改（可能是用户或其他程序改动）。请重新 roll__read_file 获取最新内容，再基于最新内容编辑，不要用旧内容重试。`,
    );
  }
  return undefined;
}

export function executeEditFile(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  input: EditFileInput,
): NormalizedToolResult {
  const payloadRejected = rejectInvalidEditPayloads(input);
  if (payloadRejected !== undefined) {
    return payloadRejected;
  }
  const path = resolveFilePath(settings.workdir, input.file_path);
  const loaded = loadTextFile(path, { maxFileBytes: settings.maxFileBytes });
  if (!loaded.ok) {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, loaded.message);
  }
  const stale = editFreshnessGuard(tracker, path, loaded);
  if (stale !== undefined) {
    return stale;
  }
  const plan = planEdits(loaded.content, input.edits);
  if (!plan.ok) {
    return plan.result;
  }
  saveTextFile(path, plan.next, loaded.hadBom);
  tracker.recordKnownContent(loaded.key, plan.next);
  return successfulToolResult(
    renderEditSuccess(path, plan.next, plan.applied, settings.maxOutputChars),
  );
}

export function buildEditFileTool(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, EDIT_FILE_TOOL_NAME, {
    annotations: EDIT_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = editFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: file_path 必须为非空字符串，edits 至少一条且每条含非空 old_string 与 new_string",
        );
      }
      const payloadRejected = rejectInvalidEditPayloads(parsed.data);
      if (payloadRejected !== undefined) {
        return payloadRejected;
      }
      const displayPath = formatPathForApproval(settings.workdir, parsed.data.file_path);
      const external = escapesWorkdir(settings.workdir, parsed.data.file_path);
      const memoryKey = external ? undefined : `${EDIT_FILE_TOOL_NAME}:workdir`;
      return gateToolCall(
        ctx,
        FILE_TOOLS_AGENT_NAME,
        EDIT_FILE_TOOL_NAME,
        parsed.data,
        EDIT_ANNOTATIONS,
        {
          explanation: `修改 ${displayPath}：${String(parsed.data.edits.length)} 处编辑`,
          ...(memoryKey !== undefined
            ? {
                memoryKey,
                sessionGrantLabel: "本会话内不再询问：修改工作目录内的文件",
              }
            : {}),
        },
      );
    },
    resources: (rawInput) => {
      const parsed = editFileInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalResourcePath(resolveFilePath(settings.workdir, parsed.data.file_path))}`
        : `file-tools:${settings.workdir}`;
      return [
        { key: OPAQUE_SIDE_EFFECT_RESOURCE, mode: TOOL_RESOURCE_ACCESS_MODES.read },
        { key, mode: TOOL_RESOURCE_ACCESS_MODES.write },
      ];
    },
    captureExecutionState: (rawInput) => {
      const parsed = editFileInputSchema.safeParse(rawInput);
      return parsed.success
        ? captureFilePathAdmission(settings.workdir, parsed.data.file_path)
        : undefined;
    },
    revalidateExecution: (rawInput, capturedState) => {
      const parsed = editFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return undefined;
      }
      return revalidateFilePathAdmission(settings.workdir, parsed.data.file_path, capturedState);
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        "对文本文件做精确字符串替换。使用前必须先 roll__read_file 读取文件；old_string 逐字复制读到的内容（不含行号前缀）且须唯一定位；同一文件多处修改放进 edits 数组一次提交，任何一条失败则整体不写入。成功返回已含修改点最新内容，无需再次读取确认。仅支持文本内容，old_string/new_string 含原始 NUL 字符（U+0000）或不成对的 UTF-16 代理项会被拒绝；需要写入转义序列文本时用双反斜杠，需要原始字节时改用 shell。",
      inputSchema: editFileInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: EditFileInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          ctx.coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          () => Promise.resolve(executeEditFile(settings, tracker, input)),
        ),
    }),
  };
}
