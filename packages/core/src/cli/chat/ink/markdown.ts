import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (match) => ENTITIES[match] ?? match);
}

function renderInline(
  tokens: Token[] | undefined,
  keyPrefix: string,
): Array<ReactElement | string> {
  if (tokens === undefined) {
    return [];
  }
  return tokens.map((token, index): ReactElement | string => {
    const key = `${keyPrefix}-${String(index)}`;
    switch (token.type) {
      case "strong":
        return h(Text, { key, bold: true }, ...renderInline(token.tokens, key));
      case "em":
        return h(Text, { key, italic: true }, ...renderInline(token.tokens, key));
      case "codespan":
        return h(Text, { key, color: "yellow" }, decodeEntities(token.text));
      case "del":
        return h(Text, { key, strikethrough: true }, ...renderInline(token.tokens, key));
      case "link":
        return h(
          Text,
          { key },
          h(Text, { color: "cyan", underline: true }, token.text),
          h(Text, { dimColor: true }, ` (${token.href})`),
        );
      case "br":
        return "\n";
      case "text":
        return token.tokens !== undefined
          ? h(Text, { key }, ...renderInline(token.tokens, key))
          : decodeEntities(token.text);
      default:
        return decodeEntities(token.raw);
    }
  });
}

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2705, 0x2705],
  [0x274c, 0x274e],
  [0x2b1b, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
];

function inRanges(codePoint: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (inRanges(codePoint, ZERO_WIDTH_RANGES)) {
      continue;
    }
    width += inRanges(codePoint, WIDE_RANGES) ? 2 : 1;
  }
  return width;
}

function inlineText(tokens: Token[] | undefined): string {
  if (tokens === undefined) {
    return "";
  }
  return tokens
    .map((token): string => {
      switch (token.type) {
        case "strong":
        case "em":
        case "del":
          return inlineText(token.tokens);
        case "codespan":
          return decodeEntities(token.text);
        case "link":
          return `${token.text} (${token.href})`;
        case "br":
          return "\n";
        case "text":
          return token.tokens !== undefined ? inlineText(token.tokens) : decodeEntities(token.text);
        default:
          return decodeEntities(token.raw);
      }
    })
    .join("");
}

function cellWidth(cell: Tokens.TableCell): number {
  const lines = inlineText(cell.tokens).split("\n");
  return lines.reduce((max, line) => Math.max(max, displayWidth(line)), 0);
}

function renderTableRow(
  cells: Tokens.TableCell[],
  widths: number[],
  key: string,
  bold: boolean,
): ReactElement {
  return h(
    Box,
    { key },
    ...cells.map((cell: Tokens.TableCell, index: number) =>
      h(
        Box,
        { key: `${key}-${String(index)}`, width: (widths[index] ?? 0) + 2 },
        h(
          Text,
          bold ? { bold: true } : {},
          ...renderInline(cell.tokens, `${key}-${String(index)}`),
        ),
      ),
    ),
  );
}

function renderTable(token: Tokens.Table, key: string): ReactElement {
  const widths = token.header.map((cell: Tokens.TableCell, index: number) => {
    let width = cellWidth(cell);
    for (const row of token.rows) {
      const rowCell = row[index];
      if (rowCell !== undefined) {
        width = Math.max(width, cellWidth(rowCell));
      }
    }
    return width;
  });
  const separator = h(
    Box,
    { key: `${key}-sep` },
    ...widths.map((width: number, index: number) =>
      h(
        Box,
        { key: `${key}-sep-${String(index)}`, width: width + 2 },
        h(Text, { dimColor: true }, "─".repeat(width)),
      ),
    ),
  );
  return h(
    Box,
    { key, flexDirection: "column" },
    renderTableRow(token.header, widths, `${key}-h`, true),
    separator,
    ...token.rows.map((row: Tokens.TableCell[], index: number) =>
      renderTableRow(row, widths, `${key}-r${String(index)}`, false),
    ),
  );
}

function renderBlock(token: Token, key: string): ReactElement | null {
  switch (token.type) {
    case "space":
      return null;
    case "heading":
      return h(Text, { key, bold: true, color: "cyan" }, ...renderInline(token.tokens, key));
    case "paragraph":
      return h(Text, { key }, ...renderInline(token.tokens, key));
    case "blockquote":
      return h(
        Box,
        { key },
        h(Text, { color: "gray" }, "│ "),
        h(Box, { flexDirection: "column" }, ...renderBlocks(token.tokens ?? [], key)),
      );
    case "code":
      return h(Box, { key, paddingLeft: 2 }, h(Text, { dimColor: true }, token.text));
    case "list":
      return h(
        Box,
        { key, flexDirection: "column" },
        ...token.items.map((item: Tokens.ListItem, index: number) => {
          const itemKey = `${key}-${String(index)}`;
          const marker = token.ordered ? `${String(Number(token.start || 1) + index)}. ` : "• ";
          return h(
            Box,
            { key: itemKey },
            h(Text, { color: "cyan" }, marker),
            h(Box, { flexDirection: "column" }, ...renderBlocks(item.tokens, itemKey)),
          );
        }),
      );
    case "hr":
      return h(Text, { key, dimColor: true }, "────────");
    case "table":
      return renderTable(token as Tokens.Table, key);
    case "text":
      return token.tokens !== undefined
        ? h(Text, { key }, ...renderInline(token.tokens, key))
        : h(Text, { key }, decodeEntities(token.text));
    default:
      return h(Text, { key }, token.raw);
  }
}

function renderBlocks(tokens: Token[], keyPrefix: string): ReactElement[] {
  return tokens
    .map((token, index) => renderBlock(token, `${keyPrefix}-${String(index)}`))
    .filter((block): block is ReactElement => block !== null)
    .map((block, index) =>
      index === 0
        ? block
        : h(Box, { key: `${keyPrefix}-gap-${String(index)}`, marginTop: 1 }, block),
    );
}

export function Markdown({ text }: { text: string }): ReactElement {
  let tokens: Token[];
  try {
    tokens = marked.lexer(text);
  } catch {
    return h(Text, null, text);
  }
  return h(Box, { flexDirection: "column" }, ...renderBlocks(tokens, "md"));
}
