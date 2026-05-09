import { homedir } from "node:os";

const DEFAULT_TERMINAL_COLUMNS = 120;
const MIN_TERMINAL_COLUMNS = 80;
const ELLIPSIS = "…";

export function resolveTerminalColumns(): number {
  return normalizeTerminalColumns(process.stdout.columns, process.env.COLUMNS);
}

export function normalizeTerminalColumns(
  streamColumns: number | undefined,
  envColumns: string | undefined,
): number {
  const resolvedColumns = Number.isFinite(streamColumns)
    ? streamColumns
    : parsePositiveInteger(envColumns);

  return Math.max(MIN_TERMINAL_COLUMNS, Math.floor(resolvedColumns ?? DEFAULT_TERMINAL_COLUMNS));
}

export function formatLocationForDisplay(location: string, maxWidth: number): string {
  return truncateMiddle(compactHomePath(location), maxWidth);
}

export function truncateMiddle(value: string, maxWidth: number): string {
  const characters = Array.from(value);

  if (maxWidth <= 0) {
    return "";
  }

  if (characters.length <= maxWidth) {
    return value;
  }

  if (maxWidth === 1) {
    return ELLIPSIS;
  }

  const availableCharacters = maxWidth - ELLIPSIS.length;
  const headLength = Math.ceil(availableCharacters * 0.55);
  const tailLength = availableCharacters - headLength;

  return `${characters.slice(0, headLength).join("")}${ELLIPSIS}${characters.slice(-tailLength).join("")}`;
}

export function indentBlock(value: string, spaces: number): string {
  const padding = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${padding}${line}`)
    .join("\n");
}

function compactHomePath(location: string): string {
  const homeDirectory = homedir();

  if (!homeDirectory || isUrl(location)) {
    return location;
  }

  const normalizedLocation = location.replaceAll("\\", "/");
  const normalizedHome = homeDirectory.replaceAll("\\", "/");

  if (normalizedLocation === normalizedHome) {
    return "~";
  }

  if (normalizedLocation.startsWith(`${normalizedHome}/`)) {
    return `~/${normalizedLocation.slice(normalizedHome.length + 1)}`;
  }

  return location;
}

function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
