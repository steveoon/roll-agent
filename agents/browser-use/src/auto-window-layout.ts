import { execFileSync } from "node:child_process";
import type { BrowserWindowBounds } from "@roll-agent/browser";

export interface WorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const DEFAULT_WORK_AREA: WorkArea = {
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
};

/** macOS menu bar + small padding; keeps Chrome below the system bar. */
const MACOS_TOP_INSET = 25;
/** Default dock reservation when auto-detect is unavailable. */
const MACOS_BOTTOM_INSET = 80;
const MAX_AUTO_LAYOUT_COLUMNS = 4;
const WINDOWS_WORK_AREA_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms;",
  "$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea;",
  "[pscustomobject]@{ x = $area.X; y = $area.Y; width = $area.Width; height = $area.Height } | ConvertTo-Json -Compress",
].join(" ");

let cachedWorkArea: WorkArea | undefined;

export function resetPrimaryWorkAreaCacheForTests(): void {
  cachedWorkArea = undefined;
}

export function getPrimaryWorkArea(): WorkArea {
  cachedWorkArea ??= detectPrimaryWorkArea();
  return cachedWorkArea;
}

export function computeAutoLayoutGrid(total: number): { cols: number; rows: number } {
  const rowCounts = computeAutoLayoutRows(total);
  return {
    cols: Math.max(...rowCounts),
    rows: rowCounts.length,
  };
}

export function computeAutoLayoutRows(total: number): readonly number[] {
  if (total <= 1) {
    return [1];
  }
  if (total === 2) {
    return [2];
  }
  if (total === 3) {
    return [3];
  }
  if (total === 4) {
    return [2, 2];
  }

  const rows = Math.ceil(total / MAX_AUTO_LAYOUT_COLUMNS);
  const baseCols = Math.floor(total / rows);
  const extraRows = total % rows;

  return Array.from({ length: rows }, (_value, row) => baseCols + (row < extraRows ? 1 : 0));
}

export function resolveAutoWindowBoundsForIndex(input: {
  readonly index: number;
  readonly total: number;
  readonly workArea: WorkArea;
}): BrowserWindowBounds {
  if (
    !Number.isInteger(input.index) ||
    input.index < 0 ||
    !Number.isInteger(input.total) ||
    input.total <= 0 ||
    input.index >= input.total
  ) {
    throw new RangeError("Auto window layout index must be within the configured instance count.");
  }

  const rowCounts = computeAutoLayoutRows(input.total);
  const rows = rowCounts.length;
  let row = 0;
  let col = input.index;
  for (const [candidateRow, cols] of rowCounts.entries()) {
    if (col < cols) {
      row = candidateRow;
      break;
    }
    col -= cols;
  }

  const cols = rowCounts[row] ?? 1;
  const x1 = input.workArea.x + Math.floor((input.workArea.width * col) / cols);
  const x2 = input.workArea.x + Math.floor((input.workArea.width * (col + 1)) / cols);
  const y1 = input.workArea.y + Math.floor((input.workArea.height * row) / rows);
  const y2 = input.workArea.y + Math.floor((input.workArea.height * (row + 1)) / rows);

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  };
}

function detectPrimaryWorkArea(): WorkArea {
  const envOverride = parseWorkAreaEnv(process.env["ROLL_BROWSER_WORK_AREA"]);
  if (envOverride !== undefined) {
    return envOverride;
  }

  if (process.platform === "darwin") {
    const desktop = detectMacOsDisplayBounds();
    if (desktop !== undefined) {
      return {
        x: desktop.x,
        y: desktop.y + MACOS_TOP_INSET,
        width: desktop.width,
        height: Math.max(400, desktop.height - MACOS_TOP_INSET - MACOS_BOTTOM_INSET),
      };
    }
  }

  if (process.platform === "linux") {
    const linux = detectLinuxPrimaryResolution();
    if (linux !== undefined) {
      return linux;
    }
  }

  if (process.platform === "win32") {
    const windows = detectWindowsPrimaryWorkArea();
    if (windows !== undefined) {
      return windows;
    }
  }

  return DEFAULT_WORK_AREA;
}

function parseWorkAreaEnv(raw: string | undefined): WorkArea | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const parts = raw.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value) || value < 0)) {
    return undefined;
  }

  const [x, y, width, height] = parts as [number, number, number, number];
  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return { x, y, width, height };
}

export function parseMacOsDisplayBounds(raw: string): WorkArea | undefined {
  const uiLooksLike = parseResolutionLine(raw, /UI Looks like:\s*(\d+)\s*x\s*(\d+)/i);
  if (uiLooksLike !== undefined) {
    return uiLooksLike;
  }

  for (const line of raw.split("\n")) {
    if (!line.includes("Resolution:") || /\bRetina\b/i.test(line)) {
      continue;
    }

    const resolution = parseResolutionLine(line, /Resolution:\s*(\d+)\s*x\s*(\d+)/i);
    if (resolution !== undefined) {
      return resolution;
    }
  }

  return undefined;
}

function parseResolutionLine(raw: string, pattern: RegExp): WorkArea | undefined {
  const match = raw.match(pattern);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return { x: 0, y: 0, width, height };
}

export function parseWindowsWorkAreaJson(raw: string): WorkArea | undefined {
  const trimmed = raw.trim().replace(/^\uFEFF/, "");
  if (trimmed.length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const x = numberFromUnknown(parsed["x"]);
  const y = numberFromUnknown(parsed["y"]);
  const width = numberFromUnknown(parsed["width"]);
  const height = numberFromUnknown(parsed["height"]);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return { x, y, width, height };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  return undefined;
}

function detectMacOsDisplayBounds(): WorkArea | undefined {
  try {
    const output = execFileSync("system_profiler", ["SPDisplaysDataType"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseMacOsDisplayBounds(output);
  } catch {
    return undefined;
  }
}

function detectWindowsPrimaryWorkArea(): WorkArea | undefined {
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_WORK_AREA_SCRIPT],
      {
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parseWindowsWorkAreaJson(output);
  } catch {
    return undefined;
  }
}

function detectLinuxPrimaryResolution(): WorkArea | undefined {
  try {
    const output = execFileSync("xrandr", ["--current"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(/(\d+)x(\d+)\+/);
    if (match?.[1] === undefined || match[2] === undefined) {
      return undefined;
    }

    const width = Number.parseInt(match[1], 10);
    const height = Number.parseInt(match[2], 10);
    if (width <= 0 || height <= 0) {
      return undefined;
    }

    return { x: 0, y: 0, width, height };
  } catch {
    return undefined;
  }
}
