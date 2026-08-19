import chalk from "chalk";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { sanitizeForDisplay } from "./tool-format.ts";

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context" | "note";

export interface DiffSegment {
  readonly text: string;
  readonly changed: boolean;
}

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly segments?: readonly DiffSegment[];
}

const PREFIXES: Record<DiffLineKind, string> = {
  meta: "",
  hunk: "",
  add: "+",
  del: "-",
  context: " ",
  note: " ",
};

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

const INTRALINE_MAX_TOKENS = 400;
const INTRALINE_MAX_CHANGED_RATIO = 0.7;
const TOKEN_PATTERN = /[A-Za-z0-9_]+|\s+|./gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN_PATTERN) ?? [];
}

function commonTokenFlags(
  left: readonly string[],
  right: readonly string[],
  minRun = 1,
): { readonly left: boolean[]; readonly right: boolean[] } {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const here = i * cols + j;
      table[here] =
        left[i] === right[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const pairs: Array<readonly [number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  const leftCommon = left.map(() => false);
  const rightCommon = right.map(() => false);
  let runStart = 0;
  for (let index = 0; index <= pairs.length; index += 1) {
    const current = pairs[index];
    const previous = pairs[index - 1];
    const continues =
      current !== undefined &&
      previous !== undefined &&
      current[0] === previous[0] + 1 &&
      current[1] === previous[1] + 1;
    if (continues) {
      continue;
    }
    if (index - runStart >= minRun) {
      for (const [li, ri] of pairs.slice(runStart, index)) {
        leftCommon[li] = true;
        rightCommon[ri] = true;
      }
    }
    runStart = index;
  }
  return { left: leftCommon, right: rightCommon };
}

function toSegments(tokens: readonly string[], common: readonly boolean[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  tokens.forEach((token, index) => {
    const changed = common[index] !== true;
    const last = segments.at(-1);
    if (last !== undefined && last.changed === changed) {
      segments[segments.length - 1] = { text: last.text + token, changed };
    } else {
      segments.push({ text: token, changed });
    }
  });
  return segments;
}

function changedRatio(segments: readonly DiffSegment[]): number {
  const total = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  if (total === 0) {
    return 0;
  }
  const changed = segments
    .filter((segment) => segment.changed)
    .reduce((sum, segment) => sum + segment.text.length, 0);
  return changed / total;
}

const INTRALINE_REFINE_MAX_CHARS = 64;

function mergeSegments(segments: readonly DiffSegment[]): DiffSegment[] {
  const merged: DiffSegment[] = [];
  for (const segment of segments) {
    if (segment.text.length === 0) {
      continue;
    }
    const last = merged.at(-1);
    if (last !== undefined && last.changed === segment.changed) {
      merged[merged.length - 1] = { text: last.text + segment.text, changed: segment.changed };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

function refineChangedPairs(
  delSegments: readonly DiffSegment[],
  addSegments: readonly DiffSegment[],
): { readonly del: DiffSegment[]; readonly add: DiffSegment[] } {
  const delChanged = delSegments.flatMap((segment, index) => (segment.changed ? [index] : []));
  const addChanged = addSegments.flatMap((segment, index) => (segment.changed ? [index] : []));
  const del = delSegments.map((segment) => [segment]);
  const add = addSegments.map((segment) => [segment]);
  for (let pair = 0; pair < Math.min(delChanged.length, addChanged.length); pair += 1) {
    const delIndex = delChanged[pair];
    const addIndex = addChanged[pair];
    const left = delIndex === undefined ? undefined : delSegments[delIndex];
    const right = addIndex === undefined ? undefined : addSegments[addIndex];
    if (
      left === undefined ||
      right === undefined ||
      delIndex === undefined ||
      addIndex === undefined ||
      left.text.length > INTRALINE_REFINE_MAX_CHARS ||
      right.text.length > INTRALINE_REFINE_MAX_CHARS
    ) {
      continue;
    }
    const leftChars = [...left.text];
    const rightChars = [...right.text];
    const common = commonTokenFlags(leftChars, rightChars, 2);
    const shared = common.left.filter(Boolean).length;
    if (shared * 2 <= Math.min(leftChars.length, rightChars.length)) {
      continue;
    }
    del[delIndex] = toSegments(leftChars, common.left);
    add[addIndex] = toSegments(rightChars, common.right);
  }
  return { del: mergeSegments(del.flat()), add: mergeSegments(add.flat()) };
}

function pairSegments(
  del: DiffLine,
  add: DiffLine,
): { readonly del: DiffSegment[]; readonly add: DiffSegment[] } | undefined {
  const left = tokenize(del.text);
  const right = tokenize(add.text);
  if (left.length > INTRALINE_MAX_TOKENS || right.length > INTRALINE_MAX_TOKENS) {
    return undefined;
  }
  const common = commonTokenFlags(left, right);
  const refined = refineChangedPairs(
    toSegments(left, common.left),
    toSegments(right, common.right),
  );
  if (
    changedRatio(refined.del) > INTRALINE_MAX_CHANGED_RATIO &&
    changedRatio(refined.add) > INTRALINE_MAX_CHANGED_RATIO
  ) {
    return undefined;
  }
  return refined;
}

export function annotateIntralineChanges(lines: readonly DiffLine[]): readonly DiffLine[] {
  const out = [...lines];
  let index = 0;
  while (index < out.length) {
    if (out[index]?.kind !== "del") {
      index += 1;
      continue;
    }
    const delStart = index;
    while (out[index]?.kind === "del") {
      index += 1;
    }
    const addStart = index;
    while (out[index]?.kind === "add") {
      index += 1;
    }
    const pairs = Math.min(addStart - delStart, index - addStart);
    for (let offset = 0; offset < pairs; offset += 1) {
      const del = out[delStart + offset];
      const add = out[addStart + offset];
      if (del === undefined || add === undefined) {
        continue;
      }
      const paired = pairSegments(del, add);
      if (paired !== undefined) {
        out[delStart + offset] = { ...del, segments: paired.del };
        out[addStart + offset] = { ...add, segments: paired.add };
      }
    }
  }
  return out;
}

export function diffBodyLines(diff: FileChangeDiff): readonly DiffLine[] {
  if (diff.unified === undefined) {
    return [];
  }
  const parsed = parseUnifiedDiff(diff.unified).filter((line) => line.kind !== "meta");
  const firstHunk = parsed.findIndex((line) => line.kind === "hunk");
  const withoutLeadingHunk =
    firstHunk === -1 ? parsed : parsed.filter((_, index) => index !== firstHunk);
  return annotateIntralineChanges(withoutLeadingHunk);
}

export function gutterNumber(line: DiffLine): number | undefined {
  return line.kind === "del" ? line.oldLine : line.newLine;
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

export function diffGutterWidth(lines: readonly DiffLine[]): number {
  const max = lines.reduce((acc, line) => Math.max(acc, gutterNumber(line) ?? 0), 0);
  return Math.max(1, String(max).length);
}

export const HUNK_SEPARATOR_GLYPH = "⋯";

export function diffLineSign(line: DiffLine): string {
  return PREFIXES[line.kind];
}

export function formatDiffGutter(line: DiffLine, width: number): string {
  if (line.kind === "hunk") {
    return `${HUNK_SEPARATOR_GLYPH.padStart(width)}   `;
  }
  const number = gutterNumber(line);
  return `${(number === undefined ? "" : String(number)).padStart(width)} ${diffLineSign(line)} `;
}

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

function paintSegments(line: DiffLine, color: boolean): string {
  const segments = line.segments ?? [{ text: line.text, changed: false }];
  return segments
    .map((segment) => {
      const text = sanitizeForDisplay(segment.text);
      if (!color) {
        return text;
      }
      const painted = paint(line.kind, text, true);
      return segment.changed ? chalk.inverse(painted) : painted;
    })
    .join("");
}

export function formatFileChangeDiffLines(
  diff: FileChangeDiff,
  options: FormatDiffOptions,
): readonly string[] {
  const header = formatDiffHeader(diff);
  const body = diffBodyLines(diff);
  const width = diffGutterWidth(body);
  const limit =
    options.maxBodyLines === undefined ? body.length : Math.max(0, options.maxBodyLines);
  const visible = body.slice(0, limit);
  const rendered = visible.map((line) => {
    const gutter = formatDiffGutter(line, width);
    const text = line.kind === "hunk" ? "" : paintSegments(line, options.color);
    return `${options.color ? chalk.dim(gutter) : gutter}${text}`;
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
