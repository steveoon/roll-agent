import chalk from "chalk";
import isUnicodeSupported from "is-unicode-supported";

export interface BannerInfo {
  readonly version: string;
  readonly model: string;
  readonly agentCount: number;
  readonly skillCount: number;
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
