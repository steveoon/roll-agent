import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { GLYPHS } from "../../utils/glyphs.ts";
import type { HistoryItem } from "./state.ts";
import { AssistantContent } from "./assistant-content.ts";
import { ToolLabel } from "./tool-label.ts";
import { BannerLinesView } from "./banner-view.ts";
import { ReasoningBlock } from "./reasoning-block.ts";

const DENIAL_TEXT_PREFIXES = ["已取消执行", "策略拒绝执行"] as const;

function isDenialText(text: string): boolean {
  const trimmed = text.trimStart();
  return DENIAL_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function HistoryItemView({ item }: { item: HistoryItem }): ReactElement {
  switch (item.kind) {
    case "banner":
      return h(BannerLinesView, { lines: item.lines });
    case "user": {
      const attachmentLabel =
        item.attachmentLabels !== undefined && item.attachmentLabels.length > 0
          ? `${GLYPHS.attach} ${item.attachmentLabels.join(" · ")}`
          : undefined;
      return h(
        Box,
        null,
        h(Text, { color: "cyan", bold: true }, "▌ "),
        item.text.length > 0 ? h(Text, { color: "cyan" }, item.text) : null,
        attachmentLabel !== undefined
          ? h(
              Text,
              { color: "cyan", dimColor: true },
              item.text.length > 0 ? `  ${attachmentLabel}` : attachmentLabel,
            )
          : null,
      );
    }
    case "assistant":
      if (isDenialText(item.text)) {
        return h(
          Box,
          null,
          h(Text, { dimColor: true }, "⊘ "),
          h(Text, { dimColor: true }, item.text.trim()),
        );
      }
      return h(AssistantContent, { text: item.text });
    case "reasoning":
      return h(ReasoningBlock, { text: item.text });
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
    case "cancelled": {
      const args = item.args.length > 0 && item.args !== "{}" ? ` ${item.args}` : "";
      return h(
        Text,
        { color: "yellow" },
        "■ ",
        h(ToolLabel, { name: item.name }),
        args.length > 0 ? h(Text, { dimColor: true }, args) : null,
        h(Text, { dimColor: true }, " 已中断"),
      );
    }
    case "compaction":
      return h(Text, { dimColor: true }, item.notice);
    case "turn-cancelled": {
      const appearance =
        item.reason === "user"
          ? { prefix: "■", textProps: { dimColor: true } }
          : item.reason === "timeout"
            ? { prefix: "⚠", textProps: { color: "yellow" as const } }
            : { prefix: "✗", textProps: { color: "red" as const } };
      return h(
        Box,
        { alignItems: "flex-start" },
        h(Box, { width: 2, flexShrink: 0 }, h(Text, appearance.textProps, appearance.prefix)),
        h(
          Box,
          { flexGrow: 1, flexShrink: 1 },
          h(Text, { ...appearance.textProps, wrap: "wrap" }, item.text),
        ),
      );
    }
    case "notice":
      return h(
        Box,
        null,
        h(Text, { color: "yellow" }, "⚠ "),
        h(Text, { color: "yellow" }, item.text),
      );
    case "error":
      return h(Box, null, h(Text, { color: "red" }, "✗ "), h(Text, { color: "red" }, item.message));
    default:
      return h(Text, null, "");
  }
}
