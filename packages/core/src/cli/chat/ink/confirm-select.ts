import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { displayWidth } from "./display-width.ts";
import type { ConfirmDecision } from "./state.ts";

export interface ConfirmSelectProps {
  readonly prompt: string;
  readonly args: string;
  readonly explanation?: string;
  readonly width: number;
  readonly maxRows: number;
  readonly onDecide: (decision: ConfirmDecision) => void;
}

type ConfirmOption = "yes" | "session" | "no";

const NEXT_CONFIRM_OPTION: Record<ConfirmOption, ConfirmOption> = {
  yes: "session",
  session: "no",
  no: "yes",
};

const CONFIRM_OPTION_DECISIONS: Record<ConfirmOption, ConfirmDecision> = {
  yes: { approved: true },
  session: { approved: true, scope: "session" },
  no: { approved: false },
};

const COMPACT_CONFIRM_MAX_ROWS = 11;

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

export function ConfirmSelect({
  prompt,
  args,
  explanation,
  width,
  maxRows,
  onDecide,
}: ConfirmSelectProps): ReactElement {
  const [selected, setSelected] = useState<ConfirmOption>("no");
  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setSelected((current) => NEXT_CONFIRM_OPTION[current]);
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
    if (lowered === "a") {
      onDecide(CONFIRM_OPTION_DECISIONS.session);
    }
  });
  const showArgs = args.length > 0 && args !== "{}";
  const boundedRows = Math.max(1, Math.floor(maxRows));
  const compact = boundedRows <= COMPACT_CONFIRM_MAX_ROWS;
  const optionRow = h(
    Box,
    compact ? { flexShrink: 0 } : { marginTop: 1, flexShrink: 0 },
    h(Text, selected === "yes" ? { color: "green" } : {}, `${selected === "yes" ? "❯ " : "  "}Yes`),
    h(
      Text,
      selected === "session" ? { color: "green" } : {},
      `   ${selected === "session" ? "❯ " : "  "}Always`,
    ),
    h(Text, selected === "no" ? { color: "green" } : {}, `   ${selected === "no" ? "❯ " : "  "}No`),
  );
  const helpRow = h(
    Box,
    { marginLeft: compact ? 0 : 1, height: 1, flexShrink: 0, overflowY: "hidden" },
    h(
      Text,
      { dimColor: true, wrap: "truncate-end" },
      compact
        ? "←→/y/a/n 选择 · Enter · Esc · ⇧Tab 自动"
        : "←→/y/a/n 选择 · Enter 确认 · Esc 取消 · a 允许并且本会话内不再询问 · Shift+Tab 自动批准本次及后续",
    ),
  );
  if (compact) {
    const contentWidth = Math.max(1, width);
    return h(
      Box,
      {
        flexDirection: "column",
        width,
        maxHeight: boundedRows,
        flexShrink: 0,
        overflowY: "hidden",
      },
      h(Text, { wrap: "truncate-end" }, truncateDisplayLine(prompt, contentWidth)),
      explanation === undefined
        ? null
        : h(Text, { color: "cyan" }, wrapDisplayLines(`AI 说明：${explanation}`, contentWidth, 2)),
      showArgs ? h(Text, { dimColor: true }, truncateDisplayLine(args, contentWidth)) : null,
      optionRow,
      helpRow,
    );
  }
  const contentWidth = Math.max(1, width - 6);
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
      showArgs ? h(Text, { dimColor: true }, args) : null,
      optionRow,
    ),
    helpRow,
  );
}
