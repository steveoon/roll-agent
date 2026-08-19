import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import {
  findAllExact,
  findOldString,
  formatMultiMatchDiagnosis,
  formatNoMatchDiagnosis,
  type MatchSpan,
} from "./match-pipeline.ts";

export interface EditEntry {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean | undefined;
}

export interface AppliedEdit {
  position: number;
  length: number;
}

export type EditPlan =
  | { readonly ok: true; readonly next: string; readonly applied: readonly AppliedEdit[] }
  | { readonly ok: false; readonly result: NormalizedToolResult };

const NO_MATCH_STEERING =
  "若修改面较大或文件已大幅变化，可改用 roll__write_file 整文件重写（需先 read_file）";

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

function failed(result: NormalizedToolResult): EditPlan {
  return { ok: false, result };
}

export function planEdits(content: string, edits: readonly EditEntry[]): EditPlan {
  const crlfOnly = detectCrlfOnly(content);
  let working = content;
  const applied: AppliedEdit[] = [];
  for (const [index, edit] of edits.entries()) {
    const label = `第 ${String(index + 1)} 条编辑（共 ${String(edits.length)} 条）`;
    if (edit.old_string === edit.new_string) {
      return failed(
        failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          `${label}：new_string 与 old_string 相同，没有可应用的变化。未写入任何修改。`,
        ),
      );
    }
    const oldAdapted = adaptLineEndings(edit.old_string, crlfOnly);
    const newAdapted = adaptLineEndings(edit.new_string, crlfOnly);
    if (oldAdapted === newAdapted) {
      return failed(
        failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          `${label}：该文件使用 CRLF 换行，行尾会自动适配，这条编辑在适配后 new_string 与 old_string 相同（只改换行符不会产生变化）。未写入任何修改。`,
        ),
      );
    }
    if (edit.replace_all === true) {
      const spans = findAllExact(working, oldAdapted);
      if (spans.length === 0) {
        return failed(
          failedToolResult(
            TOOL_OUTCOME_KINDS.toolFailed,
            `${label}失败，未写入任何修改。\n${formatNoMatchDiagnosis(working, oldAdapted)}\n${NO_MATCH_STEERING}`,
          ),
        );
      }
      working = applyReplaceAll(working, spans, newAdapted, applied);
      continue;
    }
    const match = findOldString(working, oldAdapted);
    if (match.kind === "none") {
      return failed(
        failedToolResult(
          TOOL_OUTCOME_KINDS.toolFailed,
          `${label}失败，未写入任何修改。\n${formatNoMatchDiagnosis(working, oldAdapted)}\n${NO_MATCH_STEERING}`,
        ),
      );
    }
    if (match.kind === "multiple") {
      return failed(
        failedToolResult(
          TOOL_OUTCOME_KINDS.toolFailed,
          `${label}失败，未写入任何修改。\n${formatMultiMatchDiagnosis(working, match.spans)}`,
        ),
      );
    }
    working = applySpan(working, match.span, newAdapted, applied);
  }
  if (working === content) {
    return failed(
      failedToolResult(
        TOOL_OUTCOME_KINDS.invalidInput,
        "所有编辑应用后文件内容与原文件完全相同，没有可写入的变化。未写入任何修改。",
      ),
    );
  }
  return { ok: true, next: working, applied };
}
