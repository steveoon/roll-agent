import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { LiveState } from "./state.ts";
import { ThinkingText } from "./thinking-text.ts";
import { ToolLabel } from "./tool-label.ts";
import { ReasoningBlock } from "./reasoning-block.ts";

const MAX_TAIL_LINES = 3;
const MAX_REASONING_TAIL_LINES = 3;

/** Live 推理只保留最近几行做滚动预览；完整文本在 reasoning 结束时照常落入 history。 */
export function reasoningTail(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-MAX_REASONING_TAIL_LINES);
  return lines.length > tail.length ? ["…", ...tail].join("\n") : tail.join("\n");
}

function tailLines(outputTail: string | undefined): string[] {
  if (outputTail === undefined) {
    return [];
  }
  return outputTail
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-MAX_TAIL_LINES);
}

export function LiveRegion({ live }: { live: LiveState }): ReactElement {
  const reasoningPreview = reasoningTail(live.reasoningText);
  return h(
    Box,
    { flexDirection: "column" },
    reasoningPreview.length > 0
      ? h(Box, { marginTop: 1 }, h(ReasoningBlock, { text: reasoningPreview }))
      : null,
    live.streamingText.length > 0
      ? h(
          Box,
          { marginTop: 1 },
          h(ThinkingText, {
            text: live.thinkTagOpen ? `<think>${live.streamingText}` : live.streamingText,
          }),
        )
      : null,
    ...live.activeTools.map((tool) =>
      h(
        Box,
        { key: tool.toolCallId, marginTop: 1, marginLeft: 2, flexDirection: "column" },
        h(
          Box,
          null,
          h(Text, { color: "cyan" }, "· "),
          h(ToolLabel, { name: tool.name }),
          tool.args.length > 0 ? h(Text, { dimColor: true }, ` ${tool.args}`) : null,
        ),
        ...tailLines(tool.outputTail).map((line, index) =>
          h(
            Text,
            { key: `${tool.toolCallId}-tail-${String(index)}`, dimColor: true },
            `    ${line}`,
          ),
        ),
      ),
    ),
  );
}
