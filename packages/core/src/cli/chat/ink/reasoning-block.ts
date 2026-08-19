import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { PrefixedLine } from "./prefixed-line.ts";

export function ReasoningBlock({ text }: { text: string }): ReactElement {
  return h(
    Box,
    { flexDirection: "column" },
    h(
      PrefixedLine,
      { prefix: h(Text, { color: "magenta" }, "◇ ") },
      h(Text, { dimColor: true }, "推理过程"),
    ),
    h(
      Box,
      {
        borderStyle: "single",
        borderColor: "gray",
        borderTop: false,
        borderRight: false,
        borderBottom: false,
        paddingLeft: 1,
      },
      h(Text, { dimColor: true }, text),
    ),
  );
}

export function formatReasoningDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  return seconds < 1 ? "不到 1 秒" : `${String(seconds)} 秒`;
}

export function countReasoningChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

export function formatReasoningSummary(text: string, durationMs?: number): string {
  const chars = countReasoningChars(text);
  const stats =
    durationMs === undefined
      ? `${String(chars)} 字`
      : `${formatReasoningDuration(durationMs)} · ${String(chars)} 字`;
  return `推理过程 · ${stats} · 已折叠`;
}

export interface ReasoningSummaryProps {
  readonly text: string;
  readonly durationMs?: number;
}

export function ReasoningSummary({ text, durationMs }: ReasoningSummaryProps): ReactElement {
  return h(
    PrefixedLine,
    { prefix: h(Text, { color: "magenta" }, "◇ ") },
    h(Text, { dimColor: true }, formatReasoningSummary(text, durationMs)),
  );
}
