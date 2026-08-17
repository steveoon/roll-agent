import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";

export function ReasoningBlock({ text }: { text: string }): ReactElement {
  return h(
    Box,
    { flexDirection: "column" },
    h(Box, null, h(Text, { color: "magenta" }, "◇"), h(Text, { dimColor: true }, " 推理过程")),
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

/** 统计思考内容的非空白字符数，作为折叠摘要里的“大概多少内容”。 */
export function countReasoningChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

/**
 * 折叠后的一行痕迹文案：`◇ 推理过程 · 8 秒 · 2148 字 · 已折叠`。
 * 时长未知时（如从历史消息恢复的内联思考）省略时长段。
 */
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

/** 已完成思考内容折叠后的单行痕迹；完整文本仍在 history 数据中，可随时切回完整显示。 */
export function ReasoningSummary({ text, durationMs }: ReasoningSummaryProps): ReactElement {
  return h(
    Box,
    null,
    h(Text, { color: "magenta" }, "◇"),
    h(
      Text,
      { dimColor: true },
      ` ${formatReasoningSummary(text, ...(durationMs !== undefined ? [durationMs] : []))}`,
    ),
  );
}
