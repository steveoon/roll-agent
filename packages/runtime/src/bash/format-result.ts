import type { NormalizedToolResult } from "../tool-bridge/normalize-result.ts";
import type { CapturedStream } from "./output-buffer.ts";
import { partitionModelBudget } from "./output-buffer.ts";
import { truncateMiddle } from "./truncate.ts";

export const EXEC_TIMEOUT_EXIT_CODE = 124;
export const EXIT_CODE_SIGNAL_BASE = 128;
const DEFAULT_FAILURE_EXIT_CODE = 1;

export interface BashExecResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
  readonly wallTimeMs: number;
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  readonly spawnError?: string;
}

export interface NormalizeExitCodeParams {
  readonly timedOut: boolean;
  readonly code: number | null;
  readonly signalNumber: number | undefined;
}

export function normalizeExitCode(params: NormalizeExitCodeParams): number {
  if (params.timedOut) {
    return EXEC_TIMEOUT_EXIT_CODE;
  }
  if (params.code !== null) {
    return params.code;
  }
  if (params.signalNumber !== undefined) {
    return EXIT_CODE_SIGNAL_BASE + params.signalNumber;
  }
  return DEFAULT_FAILURE_EXIT_CODE;
}

function truncationWarning(label: string, stream: CapturedStream): string | undefined {
  if (!stream.truncated) {
    return undefined;
  }
  return `Warning: ${label} 输出已截断（原始 ${String(stream.totalBytes)} 字节 / ${String(stream.totalLines)} 行）`;
}

function renderSection(label: string, text: string): string | undefined {
  const trimmed = text.length > 0 ? text : undefined;
  return trimmed !== undefined ? `[${label}]\n${trimmed}` : undefined;
}

export interface FormatBashResultInput {
  readonly result: BashExecResult;
  readonly maxModelOutputChars: number;
}

export function formatBashResult(input: FormatBashResultInput): NormalizedToolResult {
  const { result, maxModelOutputChars } = input;
  if (result.spawnError !== undefined) {
    return { output: `命令无法启动: ${result.spawnError}`, isError: true };
  }

  const budget = partitionModelBudget(maxModelOutputChars, Array.from(result.stderr.text).length);
  const stdout = truncateMiddle(result.stdout.text, budget.stdout);
  const stderr = truncateMiddle(result.stderr.text, budget.stderr);

  const lines: string[] = [];
  if (result.timedOut) {
    lines.push(`命令超时（超过 ${String(result.timeoutMs)}ms），已终止`);
  }
  lines.push(`Exit code: ${String(result.exitCode)}`);
  lines.push(`Wall time: ${(result.wallTimeMs / 1000).toFixed(1)} s`);

  const warnings = [
    result.stdout.truncated || stdout.truncated
      ? truncationWarning("stdout", result.stdout)
      : undefined,
    result.stderr.truncated || stderr.truncated
      ? truncationWarning("stderr", result.stderr)
      : undefined,
  ].filter((warning): warning is string => warning !== undefined);
  lines.push(...warnings);

  const sections = [
    renderSection("stdout", stdout.text),
    renderSection("stderr", stderr.text),
  ].filter((section): section is string => section !== undefined);

  const output = [lines.join("\n"), ...sections].join("\n\n");
  return { output, isError: result.exitCode !== 0 };
}
