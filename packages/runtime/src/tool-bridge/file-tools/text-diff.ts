import type { FileChangeDiff, FileChangeKind } from "@roll-agent/protocol";

export const FILE_CHANGE_DIFF_LIMITS = {
  maxUnifiedChars: 12_000,
  maxInputBytes: 1_048_576,
  maxEditDistance: 1_000,
  contextLines: 3,
} as const;

export type LineOp =
  | { readonly kind: "equal"; readonly oldIndex: number; readonly newIndex: number }
  | { readonly kind: "delete"; readonly oldIndex: number }
  | { readonly kind: "insert"; readonly newIndex: number };

type FileChangeDiffLimits = { readonly [K in keyof typeof FILE_CHANGE_DIFF_LIMITS]: number };

export interface BuildFileChangeDiffInput {
  readonly path: string;
  readonly change: FileChangeKind;
  readonly before: string;
  readonly after: string;
  readonly limits?: Partial<FileChangeDiffLimits>;
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

export function splitLinesKeepingNewline(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let start = 0;
  while (start < content.length) {
    const nl = content.indexOf("\n", start);
    if (nl === -1) {
      lines.push(content.slice(start));
      break;
    }
    lines.push(content.slice(start, nl + 1));
    start = nl + 1;
  }
  return lines;
}

interface TrimmedRange {
  readonly prefix: number;
  readonly suffix: number;
}

function trimCommon(before: readonly string[], after: readonly string[]): TrimmedRange {
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

function myersMiddle(
  a: readonly string[],
  b: readonly string[],
  maxEditDistance: number,
): LineOp[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEditDistance);
  const offset = max + 1;
  const width = 2 * max + 3;
  let v = new Int32Array(width);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v);
    const next = new Int32Array(v);
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        return backtrack(trace, offset, n, m, d);
      }
    }
    v = next;
  }
  return undefined;
}

function backtrack(
  trace: readonly Int32Array[],
  offset: number,
  n: number,
  m: number,
  finalD: number,
): LineOp[] {
  const reversed: LineOp[] = [];
  let x = n;
  let y = m;
  for (let d = finalD; d >= 0; d -= 1) {
    const v = trace[d];
    if (v === undefined) {
      break;
    }
    const k = x - y;
    const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : (v[offset + prevK] ?? 0);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      reversed.push({ kind: "equal", oldIndex: x, newIndex: y });
    }
    if (d > 0) {
      if (down) {
        y -= 1;
        reversed.push({ kind: "insert", newIndex: y });
      } else {
        x -= 1;
        reversed.push({ kind: "delete", oldIndex: x });
      }
    }
  }
  return reversed.reverse();
}

function replaceAllOps(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): LineOp[] {
  const ops: LineOp[] = [];
  for (let i = 0; i < oldCount; i += 1) {
    ops.push({ kind: "delete", oldIndex: oldStart + i });
  }
  for (let i = 0; i < newCount; i += 1) {
    ops.push({ kind: "insert", newIndex: newStart + i });
  }
  return ops;
}

function shiftOps(ops: readonly LineOp[], oldDelta: number, newDelta: number): LineOp[] {
  return ops.map((op) => {
    if (op.kind === "equal") {
      return { kind: "equal", oldIndex: op.oldIndex + oldDelta, newIndex: op.newIndex + newDelta };
    }
    if (op.kind === "delete") {
      return { kind: "delete", oldIndex: op.oldIndex + oldDelta };
    }
    return { kind: "insert", newIndex: op.newIndex + newDelta };
  });
}

export function diffLines(
  before: readonly string[],
  after: readonly string[],
  maxEditDistance: number,
): LineOp[] {
  const { prefix, suffix } = trimCommon(before, after);
  const ops: LineOp[] = [];
  for (let i = 0; i < prefix; i += 1) {
    ops.push({ kind: "equal", oldIndex: i, newIndex: i });
  }
  const midBefore = before.slice(prefix, before.length - suffix);
  const midAfter = after.slice(prefix, after.length - suffix);
  const middle = myersMiddle(midBefore, midAfter, maxEditDistance);
  ops.push(
    ...(middle === undefined
      ? replaceAllOps(prefix, midBefore.length, prefix, midAfter.length)
      : shiftOps(middle, prefix, prefix)),
  );
  for (let i = 0; i < suffix; i += 1) {
    ops.push({
      kind: "equal",
      oldIndex: before.length - suffix + i,
      newIndex: after.length - suffix + i,
    });
  }
  return ops;
}

interface Hunk {
  readonly ops: readonly LineOp[];
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

function groupHunks(ops: readonly LineOp[], contextLines: number): Hunk[] {
  const changeIndexes = ops.flatMap((op, index) => (op.kind === "equal" ? [] : [index]));
  if (changeIndexes.length === 0) {
    return [];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length - 1, index + contextLines);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges.map((range) => {
    const slice = ops.slice(range.start, range.end + 1);
    const oldIndexes = slice.flatMap((op) => (op.kind === "insert" ? [] : [op.oldIndex]));
    const newIndexes = slice.flatMap((op) => (op.kind === "delete" ? [] : [op.newIndex]));
    const oldFirst = oldIndexes[0];
    const newFirst = newIndexes[0];
    return {
      ops: slice,
      oldStart: oldFirst === undefined ? anchorLine(slice, "old") : oldFirst + 1,
      oldCount: oldIndexes.length,
      newStart: newFirst === undefined ? anchorLine(slice, "new") : newFirst + 1,
      newCount: newIndexes.length,
    };
  });
}

function anchorLine(slice: readonly LineOp[], side: "old" | "new"): number {
  const first = slice[0];
  if (first === undefined) {
    return 0;
  }
  if (side === "old") {
    return first.kind === "insert" ? 0 : first.oldIndex;
  }
  return first.kind === "delete" ? 0 : first.newIndex;
}

function renderLine(prefix: " " | "-" | "+", token: string): string[] {
  if (token.endsWith("\n")) {
    return [`${prefix}${token.slice(0, -1)}`];
  }
  return [`${prefix}${token}`, NO_NEWLINE_MARKER];
}

function renderHunk(hunk: Hunk, before: readonly string[], after: readonly string[]): string[] {
  const lines = [
    `@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`,
  ];
  for (const op of hunk.ops) {
    if (op.kind === "equal") {
      lines.push(...renderLine(" ", after[op.newIndex] ?? ""));
    } else if (op.kind === "delete") {
      lines.push(...renderLine("-", before[op.oldIndex] ?? ""));
    } else {
      lines.push(...renderLine("+", after[op.newIndex] ?? ""));
    }
  }
  return lines;
}

function joinWithinBudget(
  lines: readonly string[],
  maxChars: number,
): { text: string; truncated: boolean } {
  let total = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const cost = line.length + 1;
    if (total + cost > maxChars) {
      return { text: kept.map((l) => `${l}\n`).join(""), truncated: true };
    }
    kept.push(line);
    total += cost;
  }
  return { text: kept.map((l) => `${l}\n`).join(""), truncated: false };
}

function statsOnlyDiff(
  input: BuildFileChangeDiffInput,
  before: readonly string[],
  after: readonly string[],
): FileChangeDiff {
  const { prefix, suffix } = trimCommon(before, after);
  const removed = before.length - prefix - suffix;
  const added = after.length - prefix - suffix;
  return {
    path: input.path,
    change: input.change,
    added,
    removed,
    hunks: added + removed > 0 ? 1 : 0,
    truncated: false,
  };
}

export function buildFileChangeDiff(input: BuildFileChangeDiffInput): FileChangeDiff {
  const limits = { ...FILE_CHANGE_DIFF_LIMITS, ...input.limits };
  const before = splitLinesKeepingNewline(input.before);
  const after = splitLinesKeepingNewline(input.after);
  if (
    Buffer.byteLength(input.before, "utf8") + Buffer.byteLength(input.after, "utf8") >
    limits.maxInputBytes
  ) {
    return statsOnlyDiff(input, before, after);
  }
  const ops = diffLines(before, after, limits.maxEditDistance);
  const hunks = groupHunks(ops, limits.contextLines);
  const header = [
    input.change === "create" ? "--- /dev/null" : `--- a/${input.path}`,
    `+++ b/${input.path}`,
  ];
  const body = hunks.flatMap((hunk) => renderHunk(hunk, before, after));
  const { text, truncated } = joinWithinBudget([...header, ...body], limits.maxUnifiedChars);
  return {
    path: input.path,
    change: input.change,
    added: ops.filter((op) => op.kind === "insert").length,
    removed: ops.filter((op) => op.kind === "delete").length,
    hunks: hunks.length,
    unified: text,
    truncated,
  };
}
