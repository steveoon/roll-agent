import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { SessionPickerItem } from "../session-picker-format.ts";
import { truncateDisplay } from "./commands.ts";
import { displayWidth } from "./display-width.ts";

const GAP = 2;
const MARKER_WIDTH = 2;
const OCCUPANCY_LABELS = { available: "", occupied: "占用中", unknown: "状态未知" } as const;

function columnWidths(width: number) {
  const updated = width >= 64 ? 10 : 0;
  const messages = width >= 84 ? 8 : 0;
  const status = Math.min(8, Math.max(0, width - MARKER_WIDTH - GAP - 4));
  const right = [updated, messages, status].filter((value) => value > 0);
  return {
    title: Math.max(1, width - MARKER_WIDTH - right.reduce((sum, value) => sum + value + GAP, 0)),
    updated,
    messages,
    status,
  };
}

function cell(value: string, width: number, right = false): string {
  const text = truncateDisplay(value.replace(/\s+/gu, " "), width);
  const padding = " ".repeat(Math.max(0, width - displayWidth(text)));
  return right ? `${padding}${text}` : `${text}${padding}`;
}

export function historyColumnHeader(width: number): ReactElement {
  const columns = columnWidths(width);
  return h(
    Text,
    { dimColor: true },
    `  ${cell("会话", columns.title)}` +
      (columns.updated ? `  ${cell("更新时间", columns.updated, true)}` : "") +
      (columns.messages ? `  ${cell("消息数", columns.messages, true)}` : "") +
      (columns.status ? `  ${cell("状态", columns.status)}` : ""),
  );
}

export function historyItemRow(
  item: SessionPickerItem,
  active: boolean,
  width: number,
): ReactElement {
  const columns = columnWidths(width);
  const status = item.isCurrent
    ? "当前打开"
    : OCCUPANCY_LABELS[item.history?.occupancy?.status ?? "available"];
  return h(
    Box,
    { key: item.id },
    h(
      Text,
      active ? { color: "cyan", bold: true } : {},
      `${active ? "❯ " : "  "}${cell(item.title, columns.title)}`,
    ),
    columns.updated
      ? h(Text, { dimColor: true }, `  ${cell(item.history?.updated ?? "", columns.updated, true)}`)
      : null,
    columns.messages
      ? h(
          Text,
          { dimColor: true },
          `  ${cell(item.history === undefined ? "" : String(item.history.messageCount), columns.messages, true)}`,
        )
      : null,
    columns.status
      ? h(
          Text,
          item.isCurrent
            ? { color: "green", bold: true }
            : status
              ? { color: "yellow" }
              : { dimColor: true },
          `  ${cell(status, columns.status)}`,
        )
      : null,
  );
}

export function historyGroupHeading(group: string, count: number, width: number): ReactElement {
  const suffix = `  ${String(count)} `;
  const name = truncateDisplay(group, Math.max(1, width - displayWidth(suffix)));
  const rule = "─".repeat(Math.max(0, width - displayWidth(name) - displayWidth(suffix)));
  return h(
    Box,
    { key: `group:${group}` },
    h(Text, { bold: true }, name),
    h(Text, { dimColor: true }, `${suffix}${rule}`),
  );
}
