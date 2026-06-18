import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";

export interface ConfirmSelectProps {
  readonly prompt: string;
  readonly onDecide: (approved: boolean) => void;
}

export function ConfirmSelect({ prompt, onDecide }: ConfirmSelectProps): ReactElement {
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
    if (key.escape || input === "n") {
      onDecide(false);
      return;
    }
    if (input === "y") {
      onDecide(true);
    }
  });
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, null, prompt),
    h(
      Box,
      null,
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
  );
}
