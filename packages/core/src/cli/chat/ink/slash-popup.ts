import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { SlashEntry } from "./commands.ts";

const MAX_ROWS = 8;

export interface SlashPopupProps {
  readonly matches: readonly SlashEntry[];
  readonly selected: number;
  readonly width: number;
  readonly maxRows: number;
}

export function SlashPopup({ matches, selected, width, maxRows }: SlashPopupProps): ReactElement {
  if (matches.length === 0) {
    return h(
      Box,
      {
        borderStyle: "round",
        borderColor: "gray",
        paddingX: 1,
        height: Math.min(3, maxRows),
        flexShrink: 0,
        overflowY: "hidden",
      },
      h(Text, { dimColor: true }, "无匹配命令"),
    );
  }
  const innerRows = Math.max(1, maxRows - 2);
  const showPagination = innerRows >= 2 && matches.length > innerRows;
  const visibleRows = Math.max(1, Math.min(MAX_ROWS, innerRows - (showPagination ? 1 : 0)));
  const start = Math.min(
    Math.max(selected - visibleRows + 1, 0),
    Math.max(matches.length - visibleRows, 0),
  );
  const rows = matches.slice(start, start + visibleRows);
  const popupHeight = Math.min(maxRows, visibleRows + 2 + (showPagination ? 1 : 0));
  const rowWidth = Math.max(width - 4, 20);
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: "gray",
      paddingX: 1,
      height: popupHeight,
      flexShrink: 0,
      overflowY: "hidden",
    },
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
    showPagination
      ? h(Text, { dimColor: true }, `  ${String(selected + 1)}/${String(matches.length)} · ↑↓ 浏览`)
      : null,
  );
}
