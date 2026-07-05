import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput, useStdout } from "ink";

export interface ConfirmSelectProps {
  readonly prompt: string;
  readonly args: string;
  readonly onDecide: (approved: boolean) => void;
}

export function ConfirmSelect({ prompt, args, onDecide }: ConfirmSelectProps): ReactElement {
  const [selected, setSelected] = useState<"yes" | "no">("no");
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;
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
  return h(
    Box,
    { flexDirection: "column", width },
    h(
      Box,
      { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1 },
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
    h(Text, { dimColor: true }, "←→/y/n 选择 · Enter 确认 · Esc 取消 · Shift+Tab 自动批准本次及后续"),
  );
}
