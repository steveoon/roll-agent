import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { Markdown } from "./markdown.ts";
import { parseThinking } from "./thinking-text.ts";
import { ReasoningSummary } from "./reasoning-block.ts";

export interface AssistantContentProps {
  readonly text: string;
  /**
   * 已落盘历史使用：把内联 `<think>` 思考段折叠为一行摘要。
   * 流式 live 区不传此项——思考进行中始终实时展示。
   */
  readonly collapseThinking?: boolean;
}

export function AssistantContent({
  text,
  collapseThinking = false,
}: AssistantContentProps): ReactElement {
  return h(
    Box,
    { flexDirection: "column" },
    ...parseThinking(text).map((segment, index) =>
      segment.thinking && collapseThinking
        ? h(Box, { key: String(index) }, h(ReasoningSummary, { text: segment.text }))
        : segment.thinking
          ? h(Text, { key: String(index), dimColor: true }, segment.text)
          : h(Markdown, { key: String(index), text: segment.text }),
    ),
  );
}
