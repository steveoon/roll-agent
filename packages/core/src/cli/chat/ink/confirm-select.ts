import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { displayWidth } from "./display-width.ts";
import { DiffHeader } from "./diff-view.ts";
import type { ConfirmDecision } from "./state.ts";
import { sanitizeForDisplay } from "../../utils/tool-format.ts";
import { diffBodyLines, formatDiffGutter, formatDiffHeader } from "../../utils/unified-diff.ts";

export interface ConfirmSelectProps {
  readonly prompt: string;
  readonly args: string;
  readonly explanation?: string;
  readonly sessionGrantLabel?: string;
  readonly diff?: FileChangeDiff;
  readonly width: number;
  readonly maxRows: number;
  readonly onDecide: (decision: ConfirmDecision) => void;
}

type ConfirmOption = "yes" | "session" | "no";

const CONFIRM_OPTION_DECISIONS: Record<ConfirmOption, ConfirmDecision> = {
  yes: { approved: true },
  session: { approved: true, scope: "session" },
  no: { approved: false },
};

function confirmOptions(hasSession: boolean): readonly ConfirmOption[] {
  return hasSession ? (["yes", "session", "no"] as const) : (["yes", "no"] as const);
}

function stepConfirmOption(
  options: readonly ConfirmOption[],
  current: ConfirmOption,
  delta: 1 | -1,
): ConfirmOption {
  const index = options.indexOf(current);
  const from = index === -1 ? options.length - 1 : index;
  const next = options[(from + delta + options.length) % options.length];
  return next ?? "no";
}

const COMPACT_CONFIRM_MAX_ROWS = 11;
const COMPACT_ESSENTIAL_ROWS = 3;

interface CompactRowPlan {
  readonly explanationRows: number;
  readonly showLabel: boolean;
  readonly showArgs: boolean;
}

function planCompactRows(
  boundedRows: number,
  hasExplanation: boolean,
  hasLabel: boolean,
  hasArgs: boolean,
  argsBeforeSecondExplanationRow: boolean,
): CompactRowPlan {
  let spare = Math.max(0, boundedRows - COMPACT_ESSENTIAL_ROWS);
  let explanationRows = 0;
  if (hasExplanation && spare > 0) {
    explanationRows = 1;
    spare -= 1;
  }
  const showLabel = hasLabel && spare > 0;
  if (showLabel) {
    spare -= 1;
  }
  let showArgs = false;
  if (argsBeforeSecondExplanationRow && hasArgs && spare > 0) {
    showArgs = true;
    spare -= 1;
  }
  if (explanationRows === 1 && spare > 0) {
    explanationRows = 2;
    spare -= 1;
  }
  if (!showArgs) {
    showArgs = hasArgs && spare > 0;
  }
  return { explanationRows, showLabel, showArgs };
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function addEllipsis(value: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const characters = Array.from(value);
  while (characters.length > 0 && displayWidth(`${characters.join("")}…`) > safeWidth) {
    characters.pop();
  }
  return `${characters.join("")}…`;
}

function truncateDisplayLine(value: string, width: number): string {
  const normalized = normalizeInlineText(value);
  if (displayWidth(normalized) <= width) {
    return normalized;
  }
  return addEllipsis(normalized, width);
}

function clipDisplayLine(value: string, width: number): string {
  if (displayWidth(value) <= width) {
    return value;
  }
  return addEllipsis(value, width);
}

function wrapDisplayLines(value: string, width: number, maxLines: number): string {
  const normalized = normalizeInlineText(value);
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  for (const character of normalized) {
    if (current.length > 0 && displayWidth(`${current}${character}`) > safeWidth) {
      lines.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }
  const visible = lines.slice(0, maxLines);
  const lastIndex = visible.length - 1;
  visible[lastIndex] = addEllipsis(visible[lastIndex] ?? "", safeWidth);
  return visible.join("\n");
}

function diffLineTextColor(kind: "meta" | "hunk" | "add" | "del" | "context" | "note"): {
  color?: "green" | "red" | "cyan";
} {
  if (kind === "add") {
    return { color: "green" };
  }
  if (kind === "del") {
    return { color: "red" };
  }
  if (kind === "hunk") {
    return { color: "cyan" };
  }
  return {};
}

function buildConfirmDiffRows(diff: FileChangeDiff, budget: number, width: number): ReactElement[] {
  const rows: ReactElement[] = [h(DiffHeader, { key: "diff-header", diff })];
  const body = diffBodyLines(diff);
  const gutterWidth = Math.max(
    1,
    String(body.reduce((m, l) => Math.max(m, l.oldLine ?? 0, l.newLine ?? 0), 0)).length,
  );
  const bodyBudget = budget - 1;
  const visible = body.length <= bodyBudget ? body : body.slice(0, Math.max(0, bodyBudget - 1));
  visible.forEach((line, index) => {
    const gutter =
      line.kind === "hunk" || line.kind === "note"
        ? " ".repeat(gutterWidth * 2 + 2)
        : formatDiffGutter(line, gutterWidth);
    const prefix =
      line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "context" ? " " : "";
    rows.push(
      h(
        Text,
        { key: `diff-${String(index)}`, wrap: "truncate-end" },
        h(Text, { dimColor: true }, gutter),
        h(
          Text,
          diffLineTextColor(line.kind),
          clipDisplayLine(
            `${prefix}${sanitizeForDisplay(line.text)}`,
            Math.max(1, width - gutter.length),
          ),
        ),
      ),
    );
  });
  const hidden = body.length - visible.length;
  if (hidden > 0) {
    rows.push(h(Text, { key: "diff-more", dimColor: true }, `… 另 ${String(hidden)} 行`));
  }
  return rows;
}

export function ConfirmSelect({
  prompt,
  args,
  explanation,
  sessionGrantLabel,
  diff,
  width,
  maxRows,
  onDecide,
}: ConfirmSelectProps): ReactElement {
  const showArgs = diff === undefined && args.length > 0 && args !== "{}";
  const boundedRows = Math.max(1, Math.floor(maxRows));
  const compact = boundedRows <= COMPACT_CONFIRM_MAX_ROWS;
  const compactContentWidth = Math.max(1, width);
  const compactSessionGrantLabel =
    sessionGrantLabel === undefined ? undefined : normalizeInlineText(sessionGrantLabel);
  const compactSessionGrantLabelFits =
    compactSessionGrantLabel !== undefined &&
    displayWidth(compactSessionGrantLabel) <= compactContentWidth;
  const rowPlan = compact
    ? planCompactRows(
        boundedRows,
        explanation !== undefined,
        compactSessionGrantLabelFits,
        showArgs || diff !== undefined,
        diff !== undefined,
      )
    : undefined;
  const hasSession =
    sessionGrantLabel !== undefined && (rowPlan === undefined || rowPlan.showLabel);
  const options = confirmOptions(hasSession);
  const [selected, setSelected] = useState<ConfirmOption>("no");
  useInput((input, key) => {
    if (key.leftArrow || key.upArrow) {
      setSelected((current) => stepConfirmOption(options, current, -1));
      return;
    }
    if (key.rightArrow || key.downArrow) {
      setSelected((current) => stepConfirmOption(options, current, 1));
      return;
    }
    if (key.return || input.includes("\r") || input.includes("\n")) {
      onDecide(CONFIRM_OPTION_DECISIONS[selected]);
      return;
    }
    const lowered = input.toLowerCase();
    if (key.escape || lowered === "n") {
      onDecide(CONFIRM_OPTION_DECISIONS.no);
      return;
    }
    if (lowered === "y") {
      onDecide(CONFIRM_OPTION_DECISIONS.yes);
      return;
    }
    if (hasSession && lowered === "a") {
      onDecide(CONFIRM_OPTION_DECISIONS.session);
    }
  });
  const optionRow = h(
    Box,
    compact ? { flexShrink: 0 } : { marginTop: 1, flexShrink: 0 },
    h(Text, selected === "yes" ? { color: "green" } : {}, `${selected === "yes" ? "❯ " : "  "}Yes`),
    hasSession
      ? h(
          Text,
          selected === "session" ? { color: "green" } : {},
          `   ${selected === "session" ? "❯ " : "  "}Always`,
        )
      : null,
    h(Text, selected === "no" ? { color: "green" } : {}, `   ${selected === "no" ? "❯ " : "  "}No`),
  );
  const compactHelp = hasSession
    ? "←→/y/a/n 选择 · Enter · Esc · ⇧Tab 自动"
    : "←→/y/n 选择 · Enter · Esc · ⇧Tab 自动";
  const expandedHelp = hasSession
    ? `←→/y/a/n 选择 · Enter 确认 · Esc 取消 · a 允许并且本会话内不再询问 · Shift+Tab 自动批准本次及后续`
    : "←→/y/n 选择 · Enter 确认 · Esc 取消 · Shift+Tab 自动批准本次及后续";
  const helpRow = h(
    Box,
    { marginLeft: compact ? 0 : 1, height: 1, flexShrink: 0, overflowY: "hidden" },
    h(Text, { dimColor: true, wrap: "truncate-end" }, compact ? compactHelp : expandedHelp),
  );
  if (rowPlan !== undefined) {
    const { explanationRows, showLabel: showLabelRow, showArgs: showArgsRow } = rowPlan;
    return h(
      Box,
      {
        flexDirection: "column",
        width,
        maxHeight: boundedRows,
        flexShrink: 0,
        overflowY: "hidden",
      },
      h(Text, { wrap: "truncate-end" }, truncateDisplayLine(prompt, compactContentWidth)),
      explanationRows === 0
        ? null
        : h(
            Text,
            { color: "cyan" },
            wrapDisplayLines(`AI 说明：${explanation ?? ""}`, compactContentWidth, explanationRows),
          ),
      showArgsRow
        ? diff !== undefined
          ? h(
              Text,
              { wrap: "truncate-end" },
              truncateDisplayLine(formatDiffHeader(diff), compactContentWidth),
            )
          : h(Text, { dimColor: true }, truncateDisplayLine(args, compactContentWidth))
        : null,
      showLabelRow ? h(Text, { dimColor: true }, compactSessionGrantLabel ?? "") : null,
      optionRow,
      helpRow,
    );
  }
  const contentWidth = Math.max(1, width - 6);
  const explanationRows =
    explanation === undefined
      ? 0
      : Math.min(
          2,
          wrapDisplayLines(`AI 说明：${explanation}`, contentWidth, 2).split("\n").length,
        );
  const labelRows =
    sessionGrantLabel === undefined
      ? 0
      : Math.max(1, Math.ceil(displayWidth(sessionGrantLabel) / contentWidth));
  const promptRows = Math.max(1, Math.ceil(displayWidth(prompt) / contentWidth));
  const fixedRows = 2 + promptRows + explanationRows + labelRows + 2;
  const diffBudget = Math.max(0, boundedRows - 1 - fixedRows);
  const diffRows =
    diff === undefined || diffBudget < 1
      ? []
      : buildConfirmDiffRows(diff, diffBudget, contentWidth);
  return h(
    Box,
    {
      flexDirection: "column",
      width,
      maxHeight: boundedRows,
      flexShrink: 0,
      overflowY: "hidden",
    },
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: "yellow",
        paddingX: 2,
        maxHeight: Math.max(3, boundedRows - 1),
        flexShrink: 1,
        overflowY: "hidden",
      },
      h(Text, null, prompt),
      explanation === undefined
        ? null
        : h(Text, { color: "cyan" }, wrapDisplayLines(`AI 说明：${explanation}`, contentWidth, 2)),
      sessionGrantLabel === undefined ? null : h(Text, { dimColor: true }, sessionGrantLabel),
      ...diffRows,
      showArgs ? h(Text, { dimColor: true }, args) : null,
      optionRow,
    ),
    helpRow,
  );
}
