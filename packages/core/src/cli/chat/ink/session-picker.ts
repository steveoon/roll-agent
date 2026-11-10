import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { truncateDisplay } from "./commands.ts";
import { displayWidth } from "./display-width.ts";
import { sessionPickerGroups, type SessionPickerItem } from "../session-picker-format.ts";
import { historyColumnHeader, historyGroupHeading, historyItemRow } from "./session-history-row.ts";

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
  readonly cancelWhileBusy?: boolean;
  readonly error?: string;
  readonly labels?: SessionPickerLabels;
  readonly onSelect: (threadId: string, assignToCurrentProject?: boolean) => void;
  readonly onCancel: () => void;
}

const DEFAULT_LABELS: SessionPickerLabels = {
  title: "对话历史",
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
  if (item.history !== undefined || item.isCurrent) {
    return historyItemRow(item, active, contentWidth);
  }
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
  const initialCursor = Math.max(
    0,
    items.findIndex((item) => item.isCurrent),
  );
  const [cursorState, setCursorState] = useState<{
    readonly items: readonly SessionPickerItem[];
    readonly cursor: number;
  }>({ items, cursor: initialCursor });
  const cursor = cursorState.items === items ? cursorState.cursor : initialCursor;
  const boundedCursor = Math.min(cursor, Math.max(0, items.length - 1));

  useInput((input, key) => {
    if (key.escape && (!busy || props.cancelWhileBusy)) {
      onCancel();
      return;
    }
    if (busy) {
      return;
    }
    if (items.length === 0) {
      return;
    }
    if (key.upArrow) {
      setCursorState((current) => {
        const base =
          current.items === items ? Math.min(current.cursor, items.length - 1) : initialCursor;
        return { items, cursor: Math.max(0, base - 1) };
      });
      return;
    }
    if (key.downArrow) {
      setCursorState((current) => {
        const base = current.items === items ? current.cursor : initialCursor;
        return { items, cursor: Math.min(items.length - 1, base + 1) };
      });
      return;
    }
    const selected = items[boundedCursor];
    if (input === "m" && selected?.canAssignToProject) {
      onSelect(selected.id, true);
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
  const contentWidth = Math.max(1, props.width - 4);
  const selected = items[boundedCursor];
  const narrow = props.width < 80;
  const veryNarrow = props.width < 40;
  const enter = selected?.isCurrent ? (narrow ? "Enter 返回" : "Enter 返回聊天") : labels.select;
  const assignment = selected?.canAssignToProject
    ? narrow
      ? " · m 归类"
      : selected.isCurrent
        ? " · m 归入本项目"
        : " · m 归入本项目并继续"
    : "";
  const hintText = busy
    ? labels.busy
    : items.length === 0
      ? "Esc 返回"
      : veryNarrow
        ? `↑↓ Enter${selected?.canAssignToProject ? " m归类" : ""} Esc`
        : `${String(boundedCursor + 1)}/${String(items.length)} · ${narrow ? "↑↓" : "↑↓ 选择"} · ${enter}${assignment} · Esc${narrow ? "" : " 关闭"}`;
  const owner =
    selected?.history?.occupancy?.status === "occupied"
      ? selected.history.occupancy.owner?.label
      : undefined;
  const ownerHint = owner === undefined ? "" : `占用：${owner.replace(/\s+/gu, " ")}`;
  const ownerPadding = props.width - 2 - displayWidth(hintText) - displayWidth(ownerHint);
  const hint = h(
    Text,
    { dimColor: true },
    ` ${truncateDisplay(hintText, Math.max(1, props.width - 1))}${ownerHint && ownerPadding >= 2 ? `${" ".repeat(ownerPadding)}${ownerHint}` : ""}`,
  );
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

  const separateError = props.error !== undefined && boundedMaxRows > 5;
  const showColumns = items.some((item) => item.history !== undefined) && boundedMaxRows >= 8;
  const chromeRows = 4 + (separateError ? 1 : 0) + (showColumns ? 1 : 0);
  const innerBudget = Math.max(1, boundedMaxRows - chromeRows);
  const groups = sessionPickerGroups(items);
  const row = (item: SessionPickerItem, index: number) => ({
    group: item.group,
    heading: false,
    index,
    node: itemRow(item, index === boundedCursor, contentWidth),
  });
  const rows =
    groups.length === 0
      ? items.map(row)
      : groups.flatMap((group, groupIndex) => {
          const entries = items.flatMap((item, index) =>
            item.group === group ? [row(item, index)] : [],
          );
          return [
            ...(groupIndex > 0 && innerBudget >= 6
              ? [
                  {
                    group: undefined,
                    heading: false,
                    index: -1,
                    node: h(Text, { key: `space:${group}` }, " "),
                  },
                ]
              : []),
            {
              group,
              heading: true,
              index: -1,
              node: historyGroupHeading(group, entries.length, contentWidth),
            },
            ...(entries.length === 0
              ? [
                  {
                    group,
                    heading: false,
                    index: -1,
                    node: h(Text, { key: `empty:${group}`, dimColor: true }, "  暂无会话"),
                  },
                ]
              : entries),
          ];
        });
  const visibleRows = innerBudget;
  const compactGroup = groups.length > 0 && visibleRows === 1;
  const compactPrefix =
    selected?.group && contentWidth >= 28
      ? `${truncateDisplay(selected.group, Math.max(1, contentWidth - 24))} · `
      : "";
  const activeRow = Math.max(
    0,
    rows.findIndex((entry) => entry.index === boundedCursor),
  );
  let windowStart = Math.min(
    Math.max(0, activeRow - visibleRows + 1),
    Math.max(0, rows.length - visibleRows),
  );
  if (
    rows[windowStart]?.group !== undefined &&
    !rows[windowStart]?.heading &&
    activeRow >= windowStart + visibleRows - 1
  ) {
    windowStart += 1;
  }
  const first = rows[windowStart];
  const sticky =
    compactGroup || first?.group === undefined || first.heading
      ? undefined
      : rows.find((entry) => entry.heading && entry.group === first.group);
  const visible = rows.slice(windowStart, windowStart + visibleRows - (sticky ? 1 : 0));

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
      props.error !== undefined && !separateError
        ? null
        : headerRow(labels, items.length, contentWidth),
      props.error === undefined
        ? null
        : h(Text, { color: "red" }, truncateDisplay(`切换失败：${props.error}`, contentWidth)),
      showColumns ? historyColumnHeader(contentWidth) : null,
      compactGroup
        ? h(
            Box,
            null,
            h(Text, { dimColor: true }, compactPrefix),
            selected
              ? itemRow(selected, true, Math.max(1, contentWidth - displayWidth(compactPrefix)))
              : null,
          )
        : sticky?.node,
      ...(compactGroup ? [] : visible.map((entry) => entry.node)),
    ),
    hint,
  );
}
