import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { truncateDisplay } from "./commands.ts";
import { displayWidth } from "./display-width.ts";
import type { SessionPickerItem } from "../session-picker-format.ts";

export interface SessionPickerProps {
  readonly items: readonly SessionPickerItem[];
  readonly width: number;
  readonly maxRows: number;
  readonly busy: boolean;
  readonly error?: string;
  readonly onSelect: (threadId: string) => void;
  readonly onCancel: () => void;
}

export function SessionPicker(props: SessionPickerProps): ReactElement {
  const { items, busy, onSelect, onCancel } = props;
  const [cursor, setCursor] = useState(0);
  const boundedCursor = Math.min(cursor, Math.max(0, items.length - 1));

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (items.length === 0) {
      return;
    }
    if (key.upArrow) {
      setCursor((current) => Math.max(0, Math.min(current, items.length - 1) - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((current) => Math.min(items.length - 1, current + 1));
      return;
    }
    if (key.return || input.includes("\r") || input.includes("\n")) {
      const item = items[boundedCursor];
      if (item) {
        onSelect(item.id);
      }
    }
  });

  const chromeRows = 2 + (props.error === undefined ? 0 : 1);
  const visibleRows = Math.max(1, Math.floor(props.maxRows) - chromeRows);
  const windowStart = Math.min(
    Math.max(0, boundedCursor - visibleRows + 1),
    Math.max(0, items.length - visibleRows),
  );
  const visible = items.slice(windowStart, windowStart + visibleRows);
  const contentWidth = Math.max(10, props.width - 2);

  return h(
    Box,
    {
      flexDirection: "column",
      width: props.width,
      maxHeight: Math.max(3, Math.floor(props.maxRows)),
      paddingX: 1,
      flexShrink: 0,
      overflowY: "hidden",
    },
    h(Text, { bold: true }, "切换会话"),
    props.error === undefined
      ? null
      : h(Text, { color: "red" }, truncateDisplay(`切换失败：${props.error}`, contentWidth)),
    items.length === 0
      ? h(Text, { dimColor: true }, "暂无其他会话")
      : h(
          Box,
          { flexDirection: "column", flexShrink: 0 },
          ...visible.map((item, index) => {
            const active = windowStart + index === boundedCursor;
            const marker = active ? "› " : "  ";
            const title = truncateDisplay(
              item.title,
              Math.max(4, contentWidth - displayWidth(marker) - displayWidth(item.meta) - 2),
            );
            return h(
              Box,
              { key: item.id },
              h(Text, active ? { color: "green", bold: true } : {}, `${marker}${title}`),
              h(Text, { dimColor: true }, `  ${item.meta}`),
            );
          }),
        ),
    h(
      Text,
      { dimColor: true },
      busy ? "切换中…" : items.length === 0 ? "Esc 返回" : "↑↓ 选择 · Enter 切换 · Esc 取消",
    ),
  );
}
