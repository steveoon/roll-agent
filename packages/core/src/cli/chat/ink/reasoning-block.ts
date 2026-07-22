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
