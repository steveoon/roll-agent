import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { SlashCommand } from "./commands.ts";

const MAX_ROWS = 8;

export interface SlashPopupProps {
  readonly matches: readonly SlashCommand[];
  readonly selected: number;
}

export function SlashPopup({ matches, selected }: SlashPopupProps): ReactElement {
  if (matches.length === 0) {
    return h(
      Box,
      { borderStyle: "round", borderColor: "gray", paddingX: 1 },
      h(Text, { dimColor: true }, "无匹配命令"),
    );
  }
  const rows = matches.slice(0, MAX_ROWS);
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1 },
    ...rows.map((command, index) => {
      const active = index === selected;
      return h(
        Box,
        { key: command.name },
        h(
          Text,
          active ? { color: "cyan", bold: true } : { dimColor: true },
          `${active ? "❯ " : "  "}${command.name}`,
        ),
        h(Text, { dimColor: true }, `  ${command.description}`),
      );
    }),
  );
}
