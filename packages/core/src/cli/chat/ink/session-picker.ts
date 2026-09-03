import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { truncateDisplay } from "./commands.ts";
import { displayWidth } from "./display-width.ts";
import type { SessionPickerItem } from "../session-picker-format.ts";

export interface SessionPickerLabels {
  readonly title: string;
  readonly summary: (count: number) => string;
  readonly empty: string;
  readonly select: string;
  readonly busy: string;
}

export interface SessionPickerProps {
  readonly items: readonly SessionPickerItem[];
  readonly width: number;
  readonly maxRows: number;
  readonly busy: boolean;
  readonly error?: string;
  readonly labels?: SessionPickerLabels;
  readonly onSelect: (threadId: string) => void;
  readonly onCancel: () => void;
}

const DEFAULT_LABELS: SessionPickerLabels = {
  title: "切换会话",
  summary: (count) => `共 ${String(count)} 个会话`,
  empty: "暂无其他会话",
  select: "Enter 切换",
  busy: "切换中…",
};

const MARKER_WIDTH = 2;
const COLUMN_GAP = 2;
const MIN_TITLE_WIDTH = 6;

function headerRow(labels: SessionPickerLabels, count: number, contentWidth: number): ReactElement {
  const title = labels.title;
  const summary = labels.summary(count);
  const pad = contentWidth - displayWidth(title) - displayWidth(summary);
  return h(
    Box,
    null,
    h(Text, { bold: true }, title),
    pad >= COLUMN_GAP ? h(Text, { dimColor: true }, `${" ".repeat(pad)}${summary}`) : null,
  );
}

function itemRow(item: SessionPickerItem, active: boolean, contentWidth: number): ReactElement {
  const marker = active ? "❯ " : "  ";
  const titleStyle = active ? { color: "cyan", bold: true } : {};
  const metaWidth = displayWidth(item.meta);
  const titleBudget = contentWidth - MARKER_WIDTH - metaWidth - COLUMN_GAP;
  if (titleBudget < MIN_TITLE_WIDTH) {
    const title = truncateDisplay(item.title, Math.max(4, contentWidth - MARKER_WIDTH));
    return h(Box, { key: item.id }, h(Text, titleStyle, `${marker}${title}`));
  }
  const title = truncateDisplay(item.title, titleBudget);
  const pad = Math.max(COLUMN_GAP, contentWidth - MARKER_WIDTH - displayWidth(title) - metaWidth);
  return h(
    Box,
    { key: item.id },
    h(Text, titleStyle, `${marker}${title}`),
    h(Text, { dimColor: true }, `${" ".repeat(pad)}${item.meta}`),
  );
}

export function SessionPicker(props: SessionPickerProps): ReactElement {
  const { items, busy, onSelect, onCancel } = props;
  const labels = props.labels ?? DEFAULT_LABELS;
  const [cursorState, setCursorState] = useState<{
    readonly items: readonly SessionPickerItem[];
    readonly cursor: number;
  }>({ items, cursor: 0 });
  const cursor = cursorState.items === items ? cursorState.cursor : 0;
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
      setCursorState((current) => {
        const base = current.items === items ? Math.min(current.cursor, items.length - 1) : 0;
        return { items, cursor: Math.max(0, base - 1) };
      });
      return;
    }
    if (key.downArrow) {
      setCursorState((current) => {
        const base = current.items === items ? current.cursor : 0;
        return { items, cursor: Math.min(items.length - 1, base + 1) };
      });
      return;
    }
    if (key.return || input.includes("\r") || input.includes("\n")) {
      const item = items[boundedCursor];
      if (item) {
        onSelect(item.id);
      }
    }
  });

  const boundedMaxRows = Math.max(5, Math.floor(props.maxRows));
  const contentWidth = Math.max(16, props.width - 4);
  const hintText = busy
    ? labels.busy
    : items.length === 0
      ? "Esc 返回"
      : `↑↓ 选择 · ${labels.select} · Esc 取消`;
  const hint = h(Text, { dimColor: true }, ` ${hintText}`);
  const borderColor = busy ? "gray" : "cyan";

  if (items.length === 0) {
    return h(
      Box,
      { flexDirection: "column", width: props.width, flexShrink: 0, overflowY: "hidden" },
      h(
        Box,
        {
          flexDirection: "column",
          borderStyle: "round",
          borderColor: "gray",
          paddingX: 1,
          flexShrink: 0,
          overflowY: "hidden",
        },
        h(Text, { bold: true }, labels.title),
        h(Text, { dimColor: true }, labels.empty),
      ),
      hint,
    );
  }

  const chromeRows = 4 + (props.error === undefined ? 0 : 1);
  const innerBudget = Math.max(1, boundedMaxRows - chromeRows);
  const paginated = items.length > innerBudget;
  const visibleRows = Math.max(1, innerBudget - (paginated ? 1 : 0));
  const windowStart = Math.min(
    Math.max(0, boundedCursor - visibleRows + 1),
    Math.max(0, items.length - visibleRows),
  );
  const visible = items.slice(windowStart, windowStart + visibleRows);

  return h(
    Box,
    { flexDirection: "column", width: props.width, flexShrink: 0, overflowY: "hidden" },
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor,
        paddingX: 1,
        flexShrink: 0,
        overflowY: "hidden",
      },
      headerRow(labels, items.length, contentWidth),
      props.error === undefined
        ? null
        : h(Text, { color: "red" }, truncateDisplay(`切换失败：${props.error}`, contentWidth)),
      ...visible.map((item, index) =>
        itemRow(item, windowStart + index === boundedCursor, contentWidth),
      ),
      paginated
        ? h(
            Text,
            { dimColor: true },
            ` ${String(boundedCursor + 1)}/${String(items.length)} · ↑↓ 浏览`,
          )
        : null,
    ),
    hint,
  );
}
