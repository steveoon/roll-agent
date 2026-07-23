import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";

export interface ConfirmSelectProps {
  readonly prompt: string;
  readonly args: string;
  readonly width: number;
  readonly maxRows: number;
  readonly onDecide: (approved: boolean) => void;
}

export function ConfirmSelect({
  prompt,
  args,
  width,
  maxRows,
  onDecide,
}: ConfirmSelectProps): ReactElement {
  const [selected, setSelected] = useState<"yes" | "no">("no");
  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setSelected((current) => (current === "yes" ? "no" : "yes"));
      return;
    }
    if (key.return || input.includes("\r") || input.includes("\n")) {
      onDecide(selected === "yes");
      return;
    }
    const lowered = input.toLowerCase();
    if (key.escape || lowered === "n") {
      onDecide(false);
      return;
    }
    if (lowered === "y") {
      onDecide(true);
    }
  });
  const showArgs = args.length > 0 && args !== "{}";
  const boundedRows = Math.max(1, Math.floor(maxRows));
  return h(
    Box,
    {
      flexDirection: "column",
      width,
      height: boundedRows,
      flexShrink: 0,
      overflowY: "hidden",
    },
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: "yellow",
        paddingX: 2,
        height: Math.max(3, boundedRows - 1),
        flexShrink: 0,
        overflowY: "hidden",
      },
      h(Text, null, prompt),
      showArgs ? h(Text, { dimColor: true }, args) : null,
      h(
        Box,
        { marginTop: 1 },
        h(
          Text,
          selected === "yes" ? { color: "green" } : {},
          `${selected === "yes" ? "❯ " : "  "}Yes`,
        ),
        h(
          Text,
          selected === "no" ? { color: "green" } : {},
          `   ${selected === "no" ? "❯ " : "  "}No`,
        ),
      ),
    ),
    h(
      Box,
      { marginLeft: 1, height: 1, flexShrink: 0, overflowY: "hidden" },
      h(
        Text,
        { dimColor: true, wrap: "truncate-end" },
        "←→/y/n 选择 · Enter 确认 · Esc 取消 · Shift+Tab 自动批准本次及后续",
      ),
    ),
  );
}
