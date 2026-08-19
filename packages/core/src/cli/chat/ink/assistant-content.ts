import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { Markdown } from "./markdown.ts";
import { parseThinking, type TextSegment } from "./thinking-text.ts";
import { countReasoningChars, ReasoningSummary } from "./reasoning-block.ts";

export interface AssistantContentProps {
  readonly text: string;
  readonly collapseThinking?: boolean;
  readonly width?: number;
}

function renderSegment(
  segment: TextSegment,
  key: string,
  collapseThinking: boolean,
  width: number | undefined,
): ReactElement | null {
  if (!segment.thinking) {
    return h(Markdown, { key, text: segment.text, ...(width !== undefined ? { width } : {}) });
  }
  if (!collapseThinking) {
    return h(Text, { key, dimColor: true }, segment.text);
  }
  return countReasoningChars(segment.text) === 0
    ? null
    : h(Box, { key }, h(ReasoningSummary, { text: segment.text }));
}

export function AssistantContent({
  text,
  collapseThinking = false,
  width,
}: AssistantContentProps): ReactElement {
  return h(
    Box,
    { flexDirection: "column" },
    ...parseThinking(text).map((segment, index) =>
      renderSegment(segment, String(index), collapseThinking, width),
    ),
  );
}
