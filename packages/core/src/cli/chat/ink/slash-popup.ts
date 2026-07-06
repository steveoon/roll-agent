import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text, useStdout } from "ink";
import type { SlashEntry } from "./commands.ts";

const MAX_ROWS = 8;

export interface SlashPopupProps {
  readonly matches: readonly SlashEntry[];
  readonly selected: number;
}

export function SlashPopup({ matches, selected }: SlashPopupProps): ReactElement {
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  if (matches.length === 0) {
    return h(
      Box,
      { borderStyle: "round", borderColor: "gray", paddingX: 1 },
      h(Text, { dimColor: true }, "无匹配命令"),
    );
  }
  const start = Math.min(
    Math.max(selected - MAX_ROWS + 1, 0),
    Math.max(matches.length - MAX_ROWS, 0),
  );
  const rows = matches.slice(start, start + MAX_ROWS);
  const rowWidth = Math.max(width - 4, 20);
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1 },
    ...rows.map((entry, offset) => {
      const active = start + offset === selected;
      return h(
        Box,
        { key: entry.name, width: rowWidth },
        h(
          Text,
          { wrap: "truncate-end" },
          h(
            Text,
            active ? { color: "cyan", bold: true } : { dimColor: true },
            `${active ? "❯ " : "  "}${entry.name}`,
          ),
          entry.kind === "skill" ? h(Text, { color: "magenta" }, " ⚡") : null,
          h(Text, { dimColor: true }, `  ${entry.description}`),
        ),
      );
    }),
    matches.length > MAX_ROWS
      ? h(Text, { dimColor: true }, `  ${String(selected + 1)}/${String(matches.length)} · ↑↓ 浏览`)
      : null,
  );
}
