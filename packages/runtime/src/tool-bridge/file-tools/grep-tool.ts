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
import { canonicalFileKey, escapesWorkdir, resolveFilePath } from "./file-io.ts";
import { normalizeForMatch } from "./text-normalize.ts";
import { runRg } from "./rg-exec.ts";
import { gateExternalPath } from "./external-approval.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const GREP_TOOL_NAME = "grep";

const DEFAULT_MAX_RESULTS = 100;
const MAX_LINE_CHARS = 500;
const TRUNCATION_NOTICE = "结果过多已截断，请缩小范围（加 glob 或更精确的 pattern）";
const OUTPUT_CAP_NOTICE = "（输出达上限已截断，请缩小范围）";

const grepInputSchema = z.object({
  pattern: z.string().min(1).describe("搜索正则（ripgrep 语法）"),
  path: z
    .string()
    .min(1)
    .optional()
    .describe("搜索目录或文件，相对当前工作目录或绝对路径，默认工作目录"),
  glob: z.string().min(1).optional().describe('按 glob 过滤文件，如 "**/*.ts"'),
  context: z.number().int().min(0).max(10).optional().describe("每处命中前后附带的行数，默认 0"),
  ignore_case: z.boolean().optional().describe("忽略大小写，默认 false"),
  max_results: z.number().int().min(1).max(500).optional().describe("最多返回的命中行数，默认 100"),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

const GREP_ANNOTATIONS = { readOnlyHint: true } as const;

function buildRgArgs(input: GrepInput, resolvedPath: string, maxResults: number): string[] {
  return [
    "--null",
    "--line-number",
    "--no-heading",
    "--with-filename",
    "--color",
    "never",
    ...(input.ignore_case ? ["-i"] : []),
    ...(input.context ? ["-C", String(input.context)] : []),
    ...(input.glob ? ["-g", input.glob] : []),
    "--max-count",
    String(maxResults + 1),
    "-e",
    input.pattern,
    resolvedPath,
  ];
}

interface RgLineParse {
  readonly path: string;
  readonly lineNumber: number;
  readonly content: string;
  readonly isMatch: boolean;
}

// With --null, rg emits NUL right after the filename: "path\0<lineNumber><sep><content>".
// The path segment (before the NUL) may itself contain "-" or ":" (e.g. date-prefixed
// filenames like "2026-08-14-plan.md"), so it must never be parsed by a shared regex —
// splitting on the NUL byte is the only way to recover the exact filename rg reported.
const REST_LINE_PATTERN = /^(\d+)([-:])(.*)$/u;

function parseRgLine(line: string): RgLineParse | undefined {
  const nulIndex = line.indexOf("\0");
  if (nulIndex === -1) {
    return undefined;
  }
  const path = line.slice(0, nulIndex);
  const rest = line.slice(nulIndex + 1);
  const match = REST_LINE_PATTERN.exec(rest);
  if (match === null) {
    return undefined;
  }
  const lineNumberText = match[1];
  const separator = match[2];
  const content = match[3];
  if (lineNumberText === undefined || separator === undefined || content === undefined) {
    return undefined;
  }
  return { path, lineNumber: Number(lineNumberText), content, isMatch: separator === ":" };
}

function formatResultLine(lineNumber: number, content: string): string {
  const clipped =
    content.length > MAX_LINE_CHARS ? `${content.slice(0, MAX_LINE_CHARS)}…` : content;
  return `${String(lineNumber).padStart(5)}→${clipped}`;
}

interface RenderedGrepOutput {
  readonly body: string;
  readonly matchCount: number;
  readonly fileCount: number;
  readonly truncatedByMaxResults: boolean;
}

function renderGrepOutput(cwd: string, stdout: string, maxResults: number): RenderedGrepOutput {
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  let matchCount = 0;
  let truncatedByMaxResults = false;
  for (const rawLine of stdout.split("\n")) {
    if (rawLine.length === 0) {
      continue;
    }
    const parsed = parseRgLine(rawLine);
    if (parsed === undefined) {
      continue;
    }
    if (parsed.isMatch) {
      if (matchCount >= maxResults) {
        truncatedByMaxResults = true;
        break;
      }
      matchCount += 1;
    }
    const absolutePath = resolve(cwd, parsed.path);
    let bucket = groups.get(absolutePath);
    if (bucket === undefined) {
      bucket = [];
      groups.set(absolutePath, bucket);
      order.push(absolutePath);
    }
    bucket.push(formatResultLine(parsed.lineNumber, parsed.content));
  }
  const body = order.map((path) => `${path}\n${(groups.get(path) ?? []).join("\n")}`).join("\n\n");
  return { body, matchCount, fileCount: order.length, truncatedByMaxResults };
}

interface CappedOutput {
  readonly body: string;
  readonly wasCapped: boolean;
}

function capOutputBody(body: string, maxOutputChars: number): CappedOutput {
  if (body.length <= maxOutputChars) {
    return { body, wasCapped: false };
  }
  const cut = body.lastIndexOf("\n", maxOutputChars);
  return { body: body.slice(0, cut > 0 ? cut : maxOutputChars), wasCapped: true };
}

export async function executeGrep(
  settings: ResolvedFileToolsSettings,
  input: GrepInput,
): Promise<NormalizedToolResult> {
  const resolvedPath = resolveFilePath(settings.workdir, input.path ?? ".");
  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;
  const result = await runRg(buildRgArgs(input, resolvedPath, maxResults), settings.workdir);
  if (!result.ok) {
    return failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, result.errorMessage ?? "rg 执行失败");
  }
  const rendered = renderGrepOutput(settings.workdir, result.stdout, maxResults);
  if (rendered.matchCount === 0) {
    const normalized = normalizeForMatch(input.pattern);
    const parts = ["未找到匹配。"];
    if (normalized.text !== input.pattern) {
      parts.push(`pattern 含全角/智能标点，文件中可能是半角形式，试试：${normalized.text}`);
    }
    return successfulToolResult(parts.join("\n"));
  }
  const capped = capOutputBody(rendered.body, settings.maxOutputChars);
  const parts = [
    `共 ${String(rendered.matchCount)} 处命中（${String(rendered.fileCount)} 个文件）：`,
    capped.body,
  ];
  if (rendered.truncatedByMaxResults || result.truncated) {
    parts.push(TRUNCATION_NOTICE);
  }
  if (capped.wasCapped) {
    parts.push(OUTPUT_CAP_NOTICE);
  }
  return successfulToolResult(parts.join("\n\n"));
}

export function buildGrepTool(
  settings: ResolvedFileToolsSettings,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, GREP_TOOL_NAME, {
    annotations: GREP_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = grepInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: pattern 必须为非空字符串，其余参数须符合类型与范围限制",
        );
      }
      if (escapesWorkdir(settings.workdir, parsed.data.path ?? ".")) {
        const gated = await gateExternalPath(ctx, GREP_TOOL_NAME, parsed.data);
        if (gated !== undefined) {
          return gated;
        }
      }
      return gateToolCall(
        ctx,
        FILE_TOOLS_AGENT_NAME,
        GREP_TOOL_NAME,
        parsed.data,
        GREP_ANNOTATIONS,
      );
    },
    resources: (rawInput) => {
      const parsed = grepInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalFileKey(resolveFilePath(settings.workdir, parsed.data.path ?? "."))}`
        : `file-tools:${settings.workdir}`;
      return [{ key, mode: TOOL_RESOURCE_ACCESS_MODES.read }];
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        '在文件中搜索正则匹配（ripgrep 语法）。输出按文件分组，命中行前缀行号（如 "   12→"，前缀不是文件内容），可与 roll__read_file / roll__edit_file 的行号衔接。默认在当前工作目录递归搜索，可用 path 指定子目录或单个文件、glob 过滤文件、context 附带上下文行。',
      inputSchema: grepInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: GrepInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          ctx.coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          () => executeGrep(settings, input),
        ),
    }),
  };
}
