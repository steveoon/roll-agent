import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";

const SHORTCUT_ROWS = [
  ["Ctrl+Y", "复制本轮对话到剪贴板"],
  ["Ctrl+T", "释放/恢复鼠标,释放后可拖选复制"],
  ["Ctrl+V", "粘贴剪贴板图片为附件"],
  ["Shift+Tab", "开关自动批准 · Alt+./Alt+, 调推理"],
  ["PgUp/PgDn", "翻阅历史 · Ctrl+Home/End 到顶/底"],
  ["空输入 ↑", "输入历史 · Esc 中断本轮"],
] as const;

export interface ShortcutsPanelProps {
  readonly width: number;
  readonly maxRows: number;
}

export function ShortcutsPanel({ width, maxRows }: ShortcutsPanelProps): ReactElement {
  const innerRows = Math.max(1, maxRows - 2);
  const rows = SHORTCUT_ROWS.slice(0, innerRows);
  const rowWidth = Math.max(width - 4, 20);
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: "gray",
      paddingX: 1,
      height: Math.min(maxRows, rows.length + 2),
      flexShrink: 0,
      overflowY: "hidden",
    },
    ...rows.map(([keys, description]) =>
      h(
        Box,
        { key: keys, width: rowWidth },
        h(
          Text,
          { wrap: "truncate-end" },
          h(Text, { color: "cyan" }, keys),
          h(Text, { dimColor: true }, `  ${description}`),
        ),
      ),
    ),
  );
}
