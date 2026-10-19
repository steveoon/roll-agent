import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import type { FileChangeDiff, FileChangeKind } from "@roll-agent/protocol";

export const FILE_CHANGE_DIFF_LIMITS = {
  maxUnifiedChars: 12_000,
  maxInputBytes: 1_048_576,
  timeoutMs: 1_000,
  contextLines: 3,
} as const;

type FileChangeDiffLimits = { readonly [K in keyof typeof FILE_CHANGE_DIFF_LIMITS]: number };

export interface BuildFileChangeDiffInput {
  readonly path: string;
  readonly change: FileChangeKind;
  readonly before: string;
  readonly after: string;
  readonly limits?: Partial<FileChangeDiffLimits>;
}

export interface FileChangePreview {
  readonly diff: FileChangeDiff;
  /** Complete, immutable review snapshot. Never use the rendered text as write authorization. */
  readonly fullDiff: string;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - Number(text.endsWith("\n"));
}

function clipUnified(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const end = text.lastIndexOf("\n", maxChars - 1);
  return end < 0 ? "" : text.slice(0, end + 1);
}

function renderFullText(text: string): string {
  return text.length === 0 || text.endsWith("\n")
    ? text
    : `${text}\n\\ No newline at end of file\n`;
}

export function buildFileChangePreview(input: BuildFileChangeDiffInput): FileChangePreview {
  const limits = { ...FILE_CHANGE_DIFF_LIMITS, ...input.limits };
  try {
    const patch = structuredPatch(
      input.change === "create" ? "/dev/null" : `a/${input.path}`,
      `b/${input.path}`,
      input.before,
      input.after,
      undefined,
      undefined,
      { context: limits.contextLines, timeout: limits.timeoutMs },
    );
    if (patch !== undefined) {
      const fullDiff = formatPatch(patch, FILE_HEADERS_ONLY);
      let added = 0;
      let removed = 0;
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("+")) added += 1;
          if (line.startsWith("-")) removed += 1;
        }
      }
      const omitInline =
        Buffer.byteLength(input.before, "utf8") + Buffer.byteLength(input.after, "utf8") >
        limits.maxInputBytes;
      const unified = omitInline ? undefined : clipUnified(fullDiff, limits.maxUnifiedChars);
      return {
        diff: {
          path: input.path,
          change: input.change,
          added,
          removed,
          hunks: patch.hunks.length,
          ...(unified === undefined ? {} : { unified }),
          truncated: unified === undefined || unified.length < fullDiff.length,
        },
        fullDiff,
      };
    }
  } catch {
    // Rendering is separate from planning. A complete before/after review remains possible.
  }
  return {
    diff: {
      path: input.path,
      change: input.change,
      added: lineCount(input.after),
      removed: lineCount(input.before),
      hunks: 0,
      truncated: true,
      coarse: true,
    },
    fullDiff: `逐行 diff 未生成，以下为完整原文与修改后全文（非增删行统计）。\n--- 修改前：${input.path}\n${renderFullText(input.before)}+++ 修改后：${input.path}\n${renderFullText(input.after)}`,
  };
}

export function buildFileChangeDiff(input: BuildFileChangeDiffInput): FileChangeDiff {
  return buildFileChangePreview(input).diff;
}
