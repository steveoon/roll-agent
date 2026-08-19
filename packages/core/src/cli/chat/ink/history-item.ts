import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { GLYPHS } from "../../utils/glyphs.ts";
import type { ChatThinkingDisplay } from "../../../config/schema.ts";
import type { DiffDisplayMode } from "../diff-display.ts";
import { shouldExpandDiff } from "../diff-display.ts";
import type { HistoryItem } from "./state.ts";
import { AssistantContent } from "./assistant-content.ts";
import { ToolLabel } from "./tool-label.ts";
import { BannerLinesView } from "./banner-view.ts";
import { ReasoningBlock, ReasoningSummary } from "./reasoning-block.ts";
import { PrefixedLine } from "./prefixed-line.ts";
import { DiffBlock, DiffSummary, diffBodyLineCount } from "./diff-view.ts";

const DENIAL_TEXT_PREFIXES = ["已取消执行", "策略拒绝执行"] as const;

function isDenialText(text: string): boolean {
  const trimmed = text.trimStart();
  return DENIAL_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export interface HistoryItemViewProps {
  readonly item: HistoryItem;
  readonly thinkingDisplay?: ChatThinkingDisplay;
  readonly diffDisplay?: DiffDisplayMode;
  readonly width?: number;
}

export function HistoryItemView({
  item,
  thinkingDisplay = "collapsed",
  diffDisplay = "collapsed",
  width,
}: HistoryItemViewProps): ReactElement {
  const collapseThinking = thinkingDisplay === "collapsed";
  switch (item.kind) {
    case "banner":
      return h(BannerLinesView, { lines: item.lines });
    case "user": {
      const attachmentLabel =
        item.attachmentLabels !== undefined && item.attachmentLabels.length > 0
          ? `${GLYPHS.attach} ${item.attachmentLabels.join(" · ")}`
          : undefined;
      return h(
        PrefixedLine,
        { prefix: h(Text, { color: "cyan", bold: true }, "▌ ") },
        h(
          Text,
          { color: "cyan" },
          item.text.length > 0 ? item.text : null,
          attachmentLabel !== undefined
            ? h(
                Text,
                { color: "cyan", dimColor: true },
                item.text.length > 0 ? `  ${attachmentLabel}` : attachmentLabel,
              )
            : null,
        ),
      );
    }
    case "assistant":
      if (isDenialText(item.text)) {
        return h(
          PrefixedLine,
          { prefix: h(Text, { dimColor: true }, "⊘ ") },
          h(Text, { dimColor: true }, item.text.trim()),
        );
      }
      return h(AssistantContent, {
        text: item.text,
        collapseThinking,
        ...(width !== undefined ? { width } : {}),
      });
    case "reasoning":
      return collapseThinking
        ? h(ReasoningSummary, {
            text: item.text,
            ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
          })
        : h(ReasoningBlock, { text: item.text });
    case "tool": {
      const args =
        item.diff === undefined && item.args.length > 0 && item.args !== "{}" ? item.args : "";
      const line = h(
        Box,
        { flexDirection: "row" },
        h(
          Box,
          { flexShrink: 0 },
          h(
            Text,
            null,
            h(Text, item.ok ? { color: "green" } : { color: "red" }, item.ok ? "✓ " : "✗ "),
            h(ToolLabel, { name: item.name }),
          ),
        ),
        args.length > 0
          ? h(
              Box,
              { flexGrow: 1, flexShrink: 1, marginLeft: 1 },
              h(Text, { dimColor: true, wrap: "truncate-end" }, args),
            )
          : null,
      );
      if (item.diff === undefined) {
        return line;
      }
      const expanded = shouldExpandDiff(diffBodyLineCount(item.diff), diffDisplay);
      return h(
        Box,
        { flexDirection: "column" },
        line,
        expanded
          ? h(DiffBlock, { diff: item.diff })
          : h(DiffSummary, { diff: item.diff, hint: "/diff 展开" }),
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
        PrefixedLine,
        { prefix: h(Text, { color: "yellow" }, "⚠ ") },
        h(Text, { color: "yellow" }, item.text),
      );
    case "error":
      return h(
        PrefixedLine,
        { prefix: h(Text, { color: "red" }, "✗ ") },
        h(Text, { color: "red" }, item.message),
      );
    default:
      return h(Text, null, "");
  }
}
