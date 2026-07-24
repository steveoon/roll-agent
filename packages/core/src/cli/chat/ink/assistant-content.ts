import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { Markdown } from "./markdown.ts";
import { parseThinking } from "./thinking-text.ts";

export interface AssistantContentProps {
  readonly text: string;
}

export function AssistantContent({ text }: AssistantContentProps): ReactElement {
  return h(
    Box,
    { flexDirection: "column" },
    ...parseThinking(text).map((segment, index) =>
      segment.thinking
        ? h(Text, { key: String(index), dimColor: true }, segment.text)
        : h(Markdown, { key: String(index), text: segment.text }),
    ),
  );
}
