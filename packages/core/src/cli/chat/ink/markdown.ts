import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { PrefixedLine } from "./prefixed-line.ts";
import { marked, type Token, type Tokens } from "marked";
import { displayWidth } from "./display-width.ts";

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
        {
          key: `${key}-${String(index)}`,
          width: (widths[index] ?? 0) + TABLE_CELL_GAP,
          paddingRight: TABLE_CELL_GAP,
        },
        h(
          Text,
          bold ? { bold: true } : {},
          ...renderInline(cell.tokens, `${key}-${String(index)}`),
        ),
      ),
    ),
  );
}

const TABLE_CELL_GAP = 2;
const TABLE_MIN_CELL_WIDTH = 3;

function fitColumnWidths(widths: number[], available: number | undefined): number[] {
  if (available === undefined) {
    return widths;
  }
  const total = widths.reduce((sum, width) => sum + width + TABLE_CELL_GAP, 0);
  if (total <= available) {
    return widths;
  }
  const usable = Math.max(
    widths.length * TABLE_MIN_CELL_WIDTH,
    available - widths.length * TABLE_CELL_GAP,
  );
  const sum = widths.reduce((acc, width) => acc + width, 0);
  const scaled = widths.map((width) =>
    Math.max(TABLE_MIN_CELL_WIDTH, Math.floor((width / sum) * usable)),
  );
  let remainder = usable - scaled.reduce((acc, width) => acc + width, 0);
  const byWidth = widths
    .map((_, index) => index)
    .sort((a, b) => (widths[b] ?? 0) - (widths[a] ?? 0));
  for (const index of byWidth) {
    if (remainder <= 0) {
      break;
    }
    scaled[index] = (scaled[index] ?? 0) + 1;
    remainder -= 1;
  }
  return scaled;
}

function renderTable(token: Tokens.Table, key: string, width: number | undefined): ReactElement {
  const naturalWidths = token.header.map((cell: Tokens.TableCell, index: number) => {
    let cellMax = cellWidth(cell);
    for (const row of token.rows) {
      const rowCell = row[index];
      if (rowCell !== undefined) {
        cellMax = Math.max(cellMax, cellWidth(rowCell));
      }
    }
    return cellMax;
  });
  const widths = fitColumnWidths(naturalWidths, width);
  const separator = h(
    Box,
    { key: `${key}-sep` },
    ...widths.map((width: number, index: number) =>
      h(
        Box,
        {
          key: `${key}-sep-${String(index)}`,
          width: width + 2,
          paddingRight: 2,
          flexDirection: "column",
        },
        h(Box, {
          borderStyle: "single",
          borderTop: false,
          borderLeft: false,
          borderRight: false,
          borderDimColor: true,
        }),
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

function renderBlock(token: Token, key: string, width: number | undefined): ReactElement | null {
  switch (token.type) {
    case "space":
      return null;
    case "heading":
      return h(Text, { key, bold: true, color: "cyan" }, ...renderInline(token.tokens, key));
    case "paragraph":
      return h(Text, { key }, ...renderInline(token.tokens, key));
    case "blockquote":
      return h(
        PrefixedLine,
        { key, prefix: h(Text, { color: "gray" }, "│ ") },
        ...renderBlocks(token.tokens ?? [], key, narrower(width, 2)),
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
            PrefixedLine,
            { key: itemKey, prefix: h(Text, { color: "cyan" }, marker) },
            ...renderBlocks(item.tokens, itemKey, narrower(width, displayWidth(marker))),
          );
        }),
      );
    case "hr":
      return h(Text, { key, dimColor: true }, "────────");
    case "table":
      return renderTable(token as Tokens.Table, key, width);
    case "text":
      return token.tokens !== undefined
        ? h(Text, { key }, ...renderInline(token.tokens, key))
        : h(Text, { key }, decodeEntities(token.text));
    default:
      return h(Text, { key }, token.raw);
  }
}

function narrower(width: number | undefined, by: number): number | undefined {
  return width === undefined ? undefined : Math.max(1, width - by);
}

function renderBlocks(
  tokens: Token[],
  keyPrefix: string,
  width: number | undefined,
): ReactElement[] {
  return tokens
    .map((token, index) => renderBlock(token, `${keyPrefix}-${String(index)}`, width))
    .filter((block): block is ReactElement => block !== null)
    .map((block, index) =>
      index === 0
        ? block
        : h(Box, { key: `${keyPrefix}-gap-${String(index)}`, marginTop: 1 }, block),
    );
}

export interface MarkdownProps {
  readonly text: string;
  readonly width?: number;
}

export function Markdown({ text, width }: MarkdownProps): ReactElement {
  let tokens: Token[];
  try {
    tokens = marked.lexer(text);
  } catch {
    return h(Text, null, text);
  }
  return h(Box, { flexDirection: "column" }, ...renderBlocks(tokens, "md", width));
}
