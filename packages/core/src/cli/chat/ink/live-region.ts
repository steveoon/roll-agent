import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { LiveState } from "./state.ts";
import { Spinner } from "./spinner.ts";
import { ThinkingText } from "./thinking-text.ts";
import { ToolLabel } from "./tool-label.ts";

export function LiveRegion({ live }: { live: LiveState }): ReactElement {
  return h(
    Box,
    { flexDirection: "column" },
    live.streamingText.length > 0 ? h(ThinkingText, { text: live.streamingText }) : null,
    live.thinking ? h(Box, null, h(Spinner, null), h(Text, { dimColor: true }, " 思考中…")) : null,
    ...live.activeTools.map((tool) =>
      h(
        Box,
        { key: tool.toolCallId },
        h(Spinner, null),
        h(Text, null, " "),
        h(ToolLabel, { name: tool.name }),
        tool.args.length > 0 ? h(Text, { dimColor: true }, ` ${tool.args}`) : null,
      ),
    ),
    live.compacting
      ? h(Box, null, h(Spinner, null), h(Text, { dimColor: true }, " 压缩上下文中…"))
      : null,
  );
}
