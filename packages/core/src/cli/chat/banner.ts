import chalk from "chalk";
import isUnicodeSupported from "is-unicode-supported";

export interface BannerInfo {
  readonly version: string;
  readonly model: string;
  readonly agentCount: number;
  readonly skillCount: number;
  readonly instructionsFile?: string;
}

export interface BannerSpan {
  readonly text: string;
  readonly color?: string;
  readonly dim?: boolean;
}

export interface BannerLine {
  readonly spans: readonly BannerSpan[];
}

export interface BuildBannerOptions {
  readonly hints?: string;
  readonly unicode?: boolean;
}

const TAG = "Roll Agent";
const TAG_COLOR = "#e879f9";

const BLOCK_LOGO = [
  "██████╗  ██████╗ ██╗     ██╗",
  "██╔══██╗██╔═══██╗██║     ██║",
  "██████╔╝██║   ██║██║     ██║",
  "██╔══██╗██║   ██║██║     ██║",
  "██║  ██║╚██████╔╝███████╗███████╗",
  "╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝",
] as const;

const ASCII_LOGO = [
  "    ____  ____  __    __",
  "   / __ \\/ __ \\/ /   / /",
  "  / /_/ / / / / /   / /",
  " / _, _/ /_/ / /___/ /___",
  "/_/ |_|\\____/_____/_____/",
] as const;

const BLOCK_PALETTE = ["#22d3ee", "#4ac1f0", "#71aff2", "#999df5", "#c08bf7", "#e879f9"] as const;
const ASCII_PALETTE = ["#22d3ee", "#54bdf1", "#85a6f4", "#b790f6", "#e879f9"] as const;

const BLOCK_MIN_WIDTH = 36;
const ASCII_MIN_WIDTH = 28;

export function bannerTextLine(text: string, style: Omit<BannerSpan, "text"> = {}): BannerLine {
  return { spans: [{ text, ...style }] };
}

function logoFromRows(rows: readonly string[], palette: readonly string[]): BannerLine[] {
  return rows.map((row, index) => ({
    spans: [{ text: row, color: palette[index] ?? palette[palette.length - 1] ?? TAG_COLOR }],
  }));
}

function logoLines(width: number, unicode: boolean): BannerLine[] {
  if (unicode && width >= BLOCK_MIN_WIDTH) {
    return logoFromRows(BLOCK_LOGO, BLOCK_PALETTE);
  }
  if (width >= ASCII_MIN_WIDTH) {
    return logoFromRows(ASCII_LOGO, ASCII_PALETTE);
  }
  return [];
}

function infoLine(info: BannerInfo): BannerLine {
  const parts = [`v${info.version}`, info.model];
  if (info.agentCount > 0) {
    parts.push(`${String(info.agentCount)} agents`);
  }
  if (info.skillCount > 0) {
    parts.push(`${String(info.skillCount)} skills`);
  }
  if (info.instructionsFile !== undefined) {
    parts.push(info.instructionsFile);
  }
  return {
    spans: [
      { text: TAG, color: TAG_COLOR },
      { text: ` ${parts.join(" · ")}`, dim: true },
    ],
  };
}

export function buildBannerLines(
  info: BannerInfo,
  width: number,
  options: BuildBannerOptions = {},
): readonly BannerLine[] {
  const unicode = options.unicode ?? isUnicodeSupported();
  const logo = logoLines(width, unicode);
  const lines: BannerLine[] = [
    ...logo,
    ...(logo.length > 0 ? [bannerTextLine(" ")] : []),
    infoLine(info),
  ];
  if (options.hints !== undefined) {
    lines.push(bannerTextLine(options.hints, { dim: true }));
  }
  return lines;
}

/** Leading logo rows: single colored span, not dim (excludes blank / info / hints). */
export function isLogoBannerLine(line: BannerLine): boolean {
  if (line.spans.length !== 1) {
    return false;
  }
  const span = line.spans[0];
  return span !== undefined && span.color !== undefined && span.dim !== true;
}

export function splitBannerLogoLines(lines: readonly BannerLine[]): {
  readonly logo: readonly BannerLine[];
  readonly rest: readonly BannerLine[];
} {
  let count = 0;
  while (count < lines.length && lines[count] !== undefined && isLogoBannerLine(lines[count]!)) {
    count += 1;
  }
  return { logo: lines.slice(0, count), rest: lines.slice(count) };
}

function linePlainText(line: BannerLine): string {
  return line.spans.map((span) => span.text).join("");
}

export const REVEAL_EDGE_COLOR = "#f0f9ff";
const REVEAL_EDGE_WIDTH = 2;

/** Logo lines are single-span (enforced by isLogoBannerLine). */
function revealLine(line: BannerLine, visibleCols: number): BannerLine {
  const span = line.spans[0];
  if (span === undefined) {
    return line;
  }
  const chars = Array.from(span.text);
  const visibleEnd = Math.min(visibleCols, chars.length);
  const settledEnd = Math.min(Math.max(0, visibleCols - REVEAL_EDGE_WIDTH), chars.length);
  const spans: BannerSpan[] = [];
  if (settledEnd > 0) {
    spans.push({ ...span, text: chars.slice(0, settledEnd).join("") });
  }
  if (visibleEnd > settledEnd) {
    spans.push({
      ...span,
      text: chars.slice(settledEnd, visibleEnd).join(""),
      color: REVEAL_EDGE_COLOR,
    });
  }
  if (chars.length > visibleEnd) {
    spans.push({ text: " ".repeat(chars.length - visibleEnd) });
  }
  return { spans: spans.length > 0 ? spans : [{ text: "" }] };
}

/**
 * Left-to-right reveal for logo rows. `progress` in [0, 1]; layout width preserved via
 * spaces. The 1–2 columns at the reveal frontier render in a bright edge color and settle
 * to the row's palette color behind it; at progress >= 1 the edge is gone.
 */
export function revealLogoLines(
  logoLines: readonly BannerLine[],
  progress: number,
): readonly BannerLine[] {
  if (logoLines.length === 0) {
    return logoLines;
  }
  const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  if (clamped >= 1) {
    return logoLines;
  }
  const maxWidth = Math.max(0, ...logoLines.map((line) => Array.from(linePlainText(line)).length));
  const visibleCols = Math.floor(clamped * maxWidth);
  return logoLines.map((line) => revealLine(line, visibleCols));
}

function renderSpan(span: BannerSpan): string {
  let styler = chalk;
  if (span.color !== undefined) {
    styler = styler.hex(span.color);
  }
  if (span.dim === true) {
    styler = styler.dim;
  }
  return styler(span.text);
}

export function renderBannerText(lines: readonly BannerLine[]): string {
  return lines.map((line) => line.spans.map(renderSpan).join("")).join("\n");
}
