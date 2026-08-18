import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  type NormalizedToolResult,
} from "../tool-bridge/normalize-result.ts";
import type { CapturedStream } from "./output-buffer.ts";
import { partitionModelBudget } from "./output-buffer.ts";
import {
  allocateOutputDumpFile,
  describeOutputDumpRecovery,
  rollOutputDumpDir,
  writeOutputDump,
} from "./output-dump.ts";
import { evaluatePipelineExit, type ShellPipeCapability } from "./shell-pipe.ts";
import { truncateMiddle } from "./truncate.ts";

export const EXEC_TIMEOUT_EXIT_CODE = 124;
export const EXIT_CODE_SIGNAL_BASE = 128;
export const BASH_TERMINATION_CAUSES = {
  timeout: "timeout",
  abort: "abort",
} as const;
export type BashTerminationCause =
  (typeof BASH_TERMINATION_CAUSES)[keyof typeof BASH_TERMINATION_CAUSES];
const DEFAULT_FAILURE_EXIT_CODE = 1;

export interface BashExecResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
  readonly wallTimeMs: number;
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  readonly terminationCause?: BashTerminationCause;
  readonly spawnError?: string;
  readonly terminationError?: string;
  readonly pipeSegments?: readonly number[];
  readonly pipeCapability?: ShellPipeCapability;
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

function dumpFullOutput(text: string): string | undefined {
  const path = allocateOutputDumpFile(rollOutputDumpDir(), "bash");
  writeOutputDump(path, text);
  return path;
}

function renderSection(label: string, text: string): string | undefined {
  const trimmed = text.length > 0 ? text : undefined;
  return trimmed !== undefined ? `[${label}]\n${trimmed}` : undefined;
}

export interface FormatBashResultInput {
  readonly result: BashExecResult;
  readonly maxModelOutputChars: number;
  readonly fullOutputSink?: (text: string) => string | undefined;
}

export function formatBashResult(input: FormatBashResultInput): NormalizedToolResult {
  const { result, maxModelOutputChars } = input;
  if (result.spawnError !== undefined) {
    return failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, `命令无法启动: ${result.spawnError}`, {
      raw: result,
    });
  }

  const budget = partitionModelBudget(maxModelOutputChars, Array.from(result.stderr.text).length);
  const stdout = truncateMiddle(result.stdout.text, budget.stdout);
  const stderr = truncateMiddle(result.stderr.text, budget.stderr);

  const lines: string[] = [];
  if (result.terminationCause === BASH_TERMINATION_CAUSES.abort) {
    lines.push("命令已中断（收到取消请求），不能视为正常完成");
  }
  if (result.timedOut) {
    lines.push(
      result.terminationError
        ? `命令超时（超过 ${String(result.timeoutMs)}ms），终止状态未确认`
        : `命令超时（超过 ${String(result.timeoutMs)}ms），已终止`,
    );
  }
  if (result.terminationError) {
    lines.push(`终止失败: ${result.terminationError}`);
  }
  const verdict = evaluatePipelineExit({
    exitCode: result.exitCode,
    ...(result.pipeSegments !== undefined ? { segments: result.pipeSegments } : {}),
    capability: result.pipeCapability ?? "none",
  });
  lines.push(`Exit code: ${String(verdict.effectiveExitCode)}`);
  if (verdict.note !== undefined) {
    lines.push(verdict.note);
  }
  lines.push(`Wall time: ${(result.wallTimeMs / 1000).toFixed(1)} s`);

  const warnings = [
    result.stdout.truncated || stdout.truncated
      ? truncationWarning("stdout", result.stdout)
      : undefined,
    result.stderr.truncated || stderr.truncated
      ? truncationWarning("stderr", result.stderr)
      : undefined,
  ].filter((warning): warning is string => warning !== undefined);
  const anyTruncated =
    stdout.truncated || stderr.truncated || result.stdout.truncated || result.stderr.truncated;
  if (anyTruncated) {
    const fullSections = [
      result.stdout.text.length > 0 ? `[stdout]\n${result.stdout.text}` : undefined,
      result.stderr.text.length > 0 ? `[stderr]\n${result.stderr.text}` : undefined,
    ].filter((section): section is string => section !== undefined);
    const dumpedPath = (input.fullOutputSink ?? dumpFullOutput)(fullSections.join("\n\n"));
    if (dumpedPath !== undefined) {
      warnings.push(describeOutputDumpRecovery(dumpedPath));
    }
  }
  lines.push(...warnings);

  const sections = [
    renderSection("stdout", stdout.text),
    renderSection("stderr", stderr.text),
  ].filter((section): section is string => section !== undefined);

  const output = [lines.join("\n"), ...sections].join("\n\n");
  if (result.terminationCause === BASH_TERMINATION_CAUSES.abort) {
    return failedToolResult(TOOL_OUTCOME_KINDS.cancelled, output, { raw: result });
  }
  if (!verdict.ok || result.terminationError !== undefined) {
    return failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, output, { raw: result });
  }
  return successfulToolResult(output, { raw: result });
}
