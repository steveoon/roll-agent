import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { HistoryItem } from "./state.ts";
import { parseThinking } from "./thinking-text.ts";
import { Markdown } from "./markdown.ts";
import { ToolLabel } from "./tool-label.ts";

const DENIAL_TEXT_PREFIXES = ["已取消执行", "策略拒绝执行"] as const;

function isDenialText(text: string): boolean {
  const trimmed = text.trimStart();
  return DENIAL_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

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
      if (isDenialText(item.text)) {
        return h(
          Box,
          null,
          h(Text, { dimColor: true }, "⊘ "),
          h(Text, { dimColor: true }, item.text.trim()),
        );
      }
      return h(
        Box,
        { flexDirection: "column" },
        ...parseThinking(item.text).map((segment, index) =>
          segment.thinking
            ? h(Text, { key: String(index), dimColor: true }, segment.text)
            : h(Markdown, { key: String(index), text: segment.text }),
        ),
      );
    case "tool": {
      const args = item.args.length > 0 && item.args !== "{}" ? ` ${item.args}` : "";
      return h(
        Text,
        null,
        h(Text, item.ok ? { color: "green" } : { color: "red" }, item.ok ? "✓ " : "✗ "),
        h(ToolLabel, { name: item.name }),
        args.length > 0 ? h(Text, { dimColor: true }, args) : null,
      );
    }
    case "denied":
      return h(Text, { dimColor: true }, `⊘ ${item.name} ${item.label}`);
    case "compaction":
      return h(Text, { dimColor: true }, item.notice);
    case "notice":
      return h(
        Box,
        null,
        h(Text, { color: "yellow" }, "⚠ "),
        h(Text, { color: "yellow" }, item.text),
      );
    case "error":
      return h(
        Box,
        null,
        h(Text, { color: "red" }, "✗ "),
        h(Text, { color: "red" }, item.message),
      );
    default:
      return h(Text, null, "");
  }
}
