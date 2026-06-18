import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";

export interface TextPromptProps {
  readonly disabled: boolean;
  readonly onSubmit: (value: string) => void;
}

export function TextPrompt({ disabled, onSubmit }: TextPromptProps): ReactElement {
  const [value, setValue] = useState("");
  useInput(
    (input, key) => {
      if (key.backspace || key.delete) {
        setValue((current) => current.slice(0, -1));
        return;
      }
      if (
        key.ctrl ||
        key.escape ||
        key.tab ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow
      ) {
        return;
      }
      const hasEnter = key.return || input.includes("\r") || input.includes("\n");
      if (hasEnter) {
        if (key.meta) {
          setValue((current) => `${current}\n`);
          return;
        }
        const before = input.split(/[\r\n]/, 1)[0] ?? "";
        const submitted = value + before;
        setValue("");
        onSubmit(submitted);
        return;
      }
      if (input.length > 0) {
        setValue((current) => current + input);
      }
    },
    { isActive: !disabled },
  );
  const body = disabled
    ? h(Text, { dimColor: true }, value.length > 0 ? value : " ")
    : h(Text, null, `${value}▏`);
  return h(Box, null, h(Text, { color: "green" }, "› "), body);
}
