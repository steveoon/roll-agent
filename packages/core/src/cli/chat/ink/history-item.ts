import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { HistoryItem } from "./state.ts";
import { parseThinking } from "./thinking-text.ts";
import { Markdown } from "./markdown.ts";
import { ToolLabel } from "./tool-label.ts";

export function HistoryItemView({ item }: { item: HistoryItem }): ReactElement {
  switch (item.kind) {
    case "user":
      return h(
        Box,
        null,
        h(Text, { color: "cyan", bold: true }, "▌ "),
        h(Text, { color: "cyan" }, item.text),
      );
    case "assistant":
      return h(
        Box,
        { flexDirection: "column" },
        ...parseThinking(item.text).map((segment, index) =>
          segment.thinking
            ? h(Text, { key: String(index), dimColor: true }, segment.text)
            : h(Markdown, { key: String(index), text: segment.text }),
        ),
      );
    case "tool":
      return h(
        Text,
        null,
        h(Text, item.ok ? { color: "green" } : { color: "red" }, item.ok ? "✓ " : "✗ "),
        h(ToolLabel, { name: item.name }),
      );
    case "compaction":
      return h(Text, { dimColor: true }, item.notice);
    case "notice":
      return h(Text, { color: "yellow" }, `⚠ ${item.text}`);
    case "error":
      return h(Text, { color: "red" }, `✗ ${item.message}`);
    default:
      return h(Text, null, "");
  }
}
