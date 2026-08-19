import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { sanitizeForDisplay } from "../../utils/tool-format.ts";
import { diffBodyLines, formatDiffGutter, type DiffLine } from "../../utils/unified-diff.ts";

export interface DiffHeaderProps {
  readonly diff: FileChangeDiff;
}

export interface DiffBlockProps {
  readonly diff: FileChangeDiff;
  readonly maxBodyLines?: number;
  readonly collapsedHint?: string;
}

export interface DiffSummaryProps {
  readonly diff: FileChangeDiff;
  readonly hint?: string;
}

export function diffBodyLineCount(diff: FileChangeDiff): number {
  return diffBodyLines(diff).length;
}

function headerTags(diff: FileChangeDiff): string {
  const tags = [
    ...(diff.change === "create" ? ["新建"] : []),
    ...(diff.unified === undefined ? ["正文省略（文件过大）"] : diff.truncated ? ["已截断"] : []),
  ];
  return tags.length > 0 ? `  ${tags.join("  ")}` : "";
}

export function DiffHeader({ diff }: DiffHeaderProps): ReactElement {
  return h(
    Text,
    null,
    h(Text, { bold: true }, sanitizeForDisplay(diff.path)),
    h(Text, null, "  "),
    h(Text, { color: "green" }, `+${String(diff.added)}`),
    h(Text, null, " "),
    h(Text, { color: "red" }, `−${String(diff.removed)}`),
    h(Text, { dimColor: true }, headerTags(diff)),
  );
}

function lineColor(line: DiffLine): { color?: "green" | "red" | "cyan"; dimColor?: boolean } {
  switch (line.kind) {
    case "add":
      return { color: "green" };
    case "del":
      return { color: "red" };
    case "hunk":
      return { color: "cyan" };
    case "note":
      return { dimColor: true };
    default:
      return {};
  }
}

const PREFIX: Record<DiffLine["kind"], string> = {
  meta: "",
  hunk: "",
  add: "+",
  del: "-",
  context: " ",
  note: "",
};

function DiffBodyLine({
  line,
  width,
}: {
  readonly line: DiffLine;
  readonly width: number;
}): ReactElement {
  const gutter =
    line.kind === "hunk" || line.kind === "note"
      ? " ".repeat(width * 2 + 2)
      : formatDiffGutter(line, width);
  return h(
    Box,
    { flexDirection: "row" },
    h(Box, { width: gutter.length, flexShrink: 0 }, h(Text, { dimColor: true }, gutter)),
    h(
      Box,
      { flexGrow: 1, flexShrink: 1 },
      h(
        Text,
        { ...lineColor(line), wrap: "wrap" },
        `${PREFIX[line.kind]}${sanitizeForDisplay(line.text)}`,
      ),
    ),
  );
}

export function DiffBlock({ diff, maxBodyLines, collapsedHint }: DiffBlockProps): ReactElement {
  const body = diffBodyLines(diff);
  const width = Math.max(
    1,
    String(body.reduce((m, l) => Math.max(m, l.oldLine ?? 0, l.newLine ?? 0), 0)).length,
  );
  const visible = maxBodyLines === undefined ? body : body.slice(0, Math.max(0, maxBodyLines));
  const hidden = body.length - visible.length;
  return h(
    Box,
    { flexDirection: "column" },
    h(DiffHeader, { diff }),
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: "single",
        borderColor: "gray",
        borderTop: false,
        borderRight: false,
        borderBottom: false,
        paddingLeft: 1,
      },
      ...visible.map((line, index) => h(DiffBodyLine, { key: String(index), line, width })),
      hidden > 0
        ? h(
            Text,
            { dimColor: true },
            `… 另 ${String(hidden)} 行${collapsedHint !== undefined ? `（${collapsedHint}）` : ""}`,
          )
        : null,
    ),
  );
}

export function DiffSummary({ diff, hint }: DiffSummaryProps): ReactElement {
  return h(
    Text,
    null,
    h(DiffHeader, { diff }),
    h(Text, { dimColor: true }, ` · 已折叠${hint !== undefined ? ` · ${hint}` : ""}`),
  );
}
