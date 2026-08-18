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
  findAllExact,
  findOldString,
  formatMultiMatchDiagnosis,
  formatNoMatchDiagnosis,
  lineNumberAt,
  renderNumberedLines,
  type MatchSpan,
} from "./match-pipeline.ts";
import {
  canonicalResourcePath,
  captureFilePathAdmission,
  escapesWorkdir,
  formatPathForApproval,
  loadTextFile,
  resolveFilePath,
  revalidateFilePathAdmission,
  saveTextFile,
} from "./file-io.ts";
import { rejectInvalidTextPayload } from "./control-chars.ts";
import { FILE_FRESHNESS, type FileStateTracker } from "./file-state-tracker.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const EDIT_FILE_TOOL_NAME = "edit_file";

const SNAPSHOT_RADIUS = 3;

const NO_MATCH_STEERING =
  "若修改面较大或文件已大幅变化，可改用 roll__write_file 整文件重写（需先 read_file）";

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

interface AppliedEdit {
  position: number;
  length: number;
}

function detectCrlfOnly(content: string): boolean {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const bareLf = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > 0 && bareLf === 0;
}

function adaptLineEndings(value: string, crlfOnly: boolean): string {
  return crlfOnly ? value.replace(/\r?\n/g, "\r\n") : value;
}

function shiftApplied(applied: AppliedEdit[], at: number, delta: number): void {
  for (const record of applied) {
    if (record.position > at) {
      record.position += delta;
    }
  }
}

function applySpan(
  working: string,
  span: MatchSpan,
  replacement: string,
  applied: AppliedEdit[],
): string {
  const next = working.slice(0, span.start) + replacement + working.slice(span.end);
  shiftApplied(applied, span.start, replacement.length - (span.end - span.start));
  applied.push({ position: span.start, length: replacement.length });
  return next;
}

function applyReplaceAll(
  working: string,
  spans: readonly MatchSpan[],
  replacement: string,
  applied: AppliedEdit[],
): string {
  let next = working;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans.at(index);
    if (span === undefined) {
      continue;
    }
    next = next.slice(0, span.start) + replacement + next.slice(span.end);
    shiftApplied(applied, span.start, replacement.length - (span.end - span.start));
    applied.push({ position: span.start, length: replacement.length });
  }
  return next;
}

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
  const crlfOnly = detectCrlfOnly(loaded.content);
  let working = loaded.content;
  const applied: AppliedEdit[] = [];
  for (const [index, edit] of input.edits.entries()) {
    const label = `第 ${String(index + 1)} 条编辑（共 ${String(input.edits.length)} 条）`;
    if (edit.old_string === edit.new_string) {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.invalidInput,
        `${label}：new_string 与 old_string 相同，没有可应用的变化。未写入任何修改。`,
      );
    }
    const oldAdapted = adaptLineEndings(edit.old_string, crlfOnly);
    const newAdapted = adaptLineEndings(edit.new_string, crlfOnly);
    if (oldAdapted === newAdapted) {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.invalidInput,
        `${label}：该文件使用 CRLF 换行，行尾会自动适配，这条编辑在适配后 new_string 与 old_string 相同（只改换行符不会产生变化）。未写入任何修改。`,
      );
    }
    if (edit.replace_all === true) {
      const spans = findAllExact(working, oldAdapted);
      if (spans.length === 0) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.toolFailed,
          `${label}失败，未写入任何修改。\n${formatNoMatchDiagnosis(working, oldAdapted)}\n${NO_MATCH_STEERING}`,
        );
      }
      working = applyReplaceAll(working, spans, newAdapted, applied);
      continue;
    }
    const match = findOldString(working, oldAdapted);
    if (match.kind === "none") {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.toolFailed,
        `${label}失败，未写入任何修改。\n${formatNoMatchDiagnosis(working, oldAdapted)}\n${NO_MATCH_STEERING}`,
      );
    }
    if (match.kind === "multiple") {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.toolFailed,
        `${label}失败，未写入任何修改。\n${formatMultiMatchDiagnosis(working, match.spans)}`,
      );
    }
    working = applySpan(working, match.span, newAdapted, applied);
  }
  if (working === loaded.content) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.invalidInput,
      "所有编辑应用后文件内容与原文件完全相同，没有可写入的变化。未写入任何修改。",
    );
  }
  saveTextFile(path, working, loaded.hadBom);
  tracker.recordKnownContent(loaded.key, working);
  return successfulToolResult(renderEditSuccess(path, working, applied, settings.maxOutputChars));
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
