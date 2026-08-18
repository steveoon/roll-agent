import { normalizeForMatch, type NormalizedText } from "./text-normalize.ts";

export interface MatchSpan {
  readonly start: number;
  readonly end: number;
}

export type MatchResult =
  | { readonly kind: "unique"; readonly span: MatchSpan; readonly viaNormalization: boolean }
  | {
      readonly kind: "multiple";
      readonly spans: readonly MatchSpan[];
      readonly viaNormalization: boolean;
    }
  | { readonly kind: "none" };

export function findAllExact(content: string, needle: string): MatchSpan[] {
  if (needle.length === 0) {
    return [];
  }
  const spans: MatchSpan[] = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const at = content.indexOf(needle, from);
    if (at === -1) {
      break;
    }
    spans.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return spans;
}

function spanFromNormalized(
  normalized: NormalizedText,
  normStart: number,
  needleLength: number,
  contentLength: number,
): MatchSpan {
  const origStart = normalized.map[normStart];
  const lastMapped = normalized.map[normStart + needleLength - 1];
  return {
    start: origStart ?? 0,
    end: lastMapped === undefined ? contentLength : lastMapped + 1,
  };
}

export function findOldString(content: string, oldString: string): MatchResult {
  const exact = findAllExact(content, oldString);
  const firstExact = exact[0];
  if (firstExact !== undefined && exact.length === 1) {
    return { kind: "unique", span: firstExact, viaNormalization: false };
  }
  if (exact.length > 1) {
    return { kind: "multiple", spans: exact, viaNormalization: false };
  }
  const normContent = normalizeForMatch(content);
  const normNeedle = normalizeForMatch(oldString).text;
  if (normNeedle.length === 0) {
    return { kind: "none" };
  }
  const spans = findAllExact(normContent.text, normNeedle).map((span) =>
    spanFromNormalized(normContent, span.start, normNeedle.length, content.length),
  );
  const firstNorm = spans[0];
  if (firstNorm !== undefined && spans.length === 1) {
    return { kind: "unique", span: firstNorm, viaNormalization: true };
  }
  if (spans.length > 1) {
    return { kind: "multiple", spans, viaNormalization: true };
  }
  return { kind: "none" };
}

export function renderNumberedLines(lines: readonly string[], firstLineNumber: number): string {
  return lines
    .map((line, index) => `${String(firstLineNumber + index).padStart(5)}→${line}`)
    .join("\n");
}

export function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < content.length; index += 1) {
    if (content.charAt(index) === "\n") {
      line += 1;
    }
  }
  return line;
}

function contextWindow(content: string, targetLine: number, radius: number): string {
  const lines = content.split("\n");
  const startLine = Math.max(1, targetLine - radius);
  const endLine = Math.min(lines.length, targetLine + radius);
  return renderNumberedLines(lines.slice(startLine - 1, endLine), startLine);
}

function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charAt(prefix) === b.charAt(prefix)) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < max - prefix &&
    a.charAt(a.length - 1 - suffix) === b.charAt(b.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return (prefix + suffix) / Math.max(a.length, b.length);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function firstDifference(expected: string, actual: string): string {
  const max = Math.min(expected.length, actual.length);
  let at = 0;
  while (at < max && expected.charAt(at) === actual.charAt(at)) {
    at += 1;
  }
  return `第 ${String(at + 1)} 个字符起不同：old_string 为 "${clip(expected.slice(at), 30)}"，文件为 "${clip(actual.slice(at), 30)}"`;
}

export function lineNumberPrefixWarning(oldString: string): string | undefined {
  return /^\s*\d+→/m.test(oldString)
    ? '警告：old_string 疑似包含 read_file 的行号前缀（如 "  12→"）。行号前缀不是文件内容，请删除前缀后重试。'
    : undefined;
}

export function formatNoMatchDiagnosis(content: string, oldString: string): string {
  const parts: string[] = ["old_string 未在文件中找到匹配。"];
  const prefixWarning = lineNumberPrefixWarning(oldString);
  if (prefixWarning !== undefined) {
    parts.push(prefixWarning);
  }
  const probe = oldString
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (probe !== undefined) {
    const lines = content.split("\n");
    let bestLine = 0;
    let bestScore = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const score = similarity(probe, (lines[index] ?? "").trim());
      if (score > bestScore) {
        bestScore = score;
        bestLine = index + 1;
      }
    }
    if (bestScore >= 0.3 && bestLine > 0) {
      const actual = (lines[bestLine - 1] ?? "").trim();
      parts.push(`最接近的位置在第 ${String(bestLine)} 行：`);
      parts.push(contextWindow(content, bestLine, 3));
      if (actual !== probe) {
        parts.push(firstDifference(probe, actual));
      }
    }
  }
  parts.push(
    "文件可能在你上次读取后有变化，或 old_string 与文件内容存在不可见差异。请重新 read_file 并逐字复制目标内容。",
  );
  return parts.join("\n");
}

export function formatMultiMatchDiagnosis(content: string, spans: readonly MatchSpan[]): string {
  const lines = content.split("\n");
  const shown = spans.slice(0, 8);
  const entries = shown.map((span) => {
    const line = lineNumberAt(content, span.start);
    return `  第 ${String(line)} 行：${clip((lines[line - 1] ?? "").trim(), 60)}`;
  });
  const suffix = spans.length > shown.length ? `\n  …（共 ${String(spans.length)} 处）` : "";
  return [
    `old_string 在文件中出现 ${String(spans.length)} 次，需要唯一匹配：`,
    `${entries.join("\n")}${suffix}`,
    "请在 old_string 中加入更多上下文行使其唯一，或设置 replace_all: true 一次替换全部。",
  ].join("\n");
}
