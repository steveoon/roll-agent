import chalk from "chalk";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { sanitizeForDisplay } from "./tool-format.ts";

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context" | "note";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface FormatDiffOptions {
  readonly color: boolean;
  readonly maxBodyLines?: number;
  readonly collapsedHint?: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

export function parseUnifiedDiff(unified: string): readonly DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const raw = unified.endsWith("\n") ? unified.slice(0, -1) : unified;
  if (raw.length === 0) {
    return out;
  }
  for (const line of raw.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      out.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("\\")) {
      out.push({ kind: "note", text: line });
      continue;
    }
    const body = line.slice(1);
    if (line.startsWith("+")) {
      out.push({ kind: "add", text: body, newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", text: body, oldLine });
      oldLine += 1;
    } else {
      out.push({ kind: "context", text: body, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return out;
}

export function diffBodyLines(diff: FileChangeDiff): readonly DiffLine[] {
  return diff.unified === undefined
    ? []
    : parseUnifiedDiff(diff.unified).filter((line) => line.kind !== "meta");
}

export function formatDiffStats(diff: FileChangeDiff): string {
  return `+${String(diff.added)} −${String(diff.removed)}`;
}

export function formatDiffHeader(diff: FileChangeDiff): string {
  const tags = [
    ...(diff.change === "create" ? ["新建"] : []),
    ...(diff.unified === undefined ? ["正文省略（文件过大）"] : diff.truncated ? ["已截断"] : []),
  ];
  return [sanitizeForDisplay(diff.path), formatDiffStats(diff), ...tags].join("  ");
}

function gutterWidth(lines: readonly DiffLine[]): number {
  const max = lines.reduce((acc, line) => Math.max(acc, line.oldLine ?? 0, line.newLine ?? 0), 0);
  return Math.max(1, String(max).length);
}

export function formatDiffGutter(line: DiffLine, width: number): string {
  const left = line.oldLine === undefined ? "" : String(line.oldLine);
  const right = line.newLine === undefined ? "" : String(line.newLine);
  return `${left.padStart(width)} ${right.padStart(width)} `;
}

const PREFIXES: Record<DiffLineKind, string> = {
  meta: "",
  hunk: "",
  add: "+",
  del: "-",
  context: " ",
  note: "",
};

function paint(kind: DiffLineKind, text: string, color: boolean): string {
  if (!color) {
    return text;
  }
  switch (kind) {
    case "add":
      return chalk.green(text);
    case "del":
      return chalk.red(text);
    case "hunk":
      return chalk.cyan(text);
    case "note":
    case "meta":
      return chalk.dim(text);
    default:
      return text;
  }
}

export function formatFileChangeDiffLines(
  diff: FileChangeDiff,
  options: FormatDiffOptions,
): readonly string[] {
  const header = formatDiffHeader(diff);
  const body = diffBodyLines(diff);
  const width = gutterWidth(body);
  const limit =
    options.maxBodyLines === undefined ? body.length : Math.max(0, options.maxBodyLines);
  const visible = body.slice(0, limit);
  const rendered = visible.map((line) => {
    const gutter =
      line.kind === "hunk" || line.kind === "note"
        ? " ".repeat(width * 2 + 2)
        : formatDiffGutter(line, width);
    const text = `${PREFIXES[line.kind]}${sanitizeForDisplay(line.text)}`;
    return `${options.color ? chalk.dim(gutter) : gutter}${paint(line.kind, text, options.color)}`;
  });
  const hidden = body.length - visible.length;
  const tail =
    hidden > 0
      ? [
          `… 另 ${String(hidden)} 行${options.collapsedHint !== undefined ? `（${options.collapsedHint}）` : ""}`,
        ]
      : [];
  return [
    options.color ? chalk.bold(header) : header,
    ...rendered,
    ...tail.map((t) => (options.color ? chalk.dim(t) : t)),
  ];
}
