import type { spawnSync as SpawnSync } from "node:child_process";

export const SIGPIPE_EXIT_CODE = 141;
export const PIPE_STATUS_ENV = "ROLL_PIPE_STATUS_FILE";

export const SHELL_PIPE_CAPABILITIES = ["segments", "pipefail", "none"] as const;
export type ShellPipeCapability = (typeof SHELL_PIPE_CAPABILITIES)[number];

export const PIPE_SEGMENT_ARRAYS = ["PIPESTATUS", "pipestatus"] as const;
export type PipeSegmentArray = (typeof PIPE_SEGMENT_ARRAYS)[number];

export interface ShellPipeProbe {
  readonly capability: ShellPipeCapability;
  readonly segmentArray?: PipeSegmentArray;
}

const PROBE_TIMEOUT_MS = 2_000;

export function probeShellPipeCapability(
  shellPath: string,
  spawnSyncImpl: typeof SpawnSync,
): ShellPipeProbe {
  const segmentProbe = spawnSyncImpl(
    shellPath,
    ["-c", `false | true; printf "%s|%s" "\${PIPESTATUS[*]:-}" "\${pipestatus[*]:-}"`],
    { encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
  );
  if (!segmentProbe.error && segmentProbe.status === 0) {
    const stdout = segmentProbe.stdout ?? "";
    if (stdout.startsWith("1 0")) {
      return { capability: "segments", segmentArray: "PIPESTATUS" };
    }
    if (stdout.endsWith("1 0") && stdout.includes("|")) {
      return { capability: "segments", segmentArray: "pipestatus" };
    }
  }
  const pipefailProbe = spawnSyncImpl(
    shellPath,
    ["-c", "( set -o pipefail ) 2>/dev/null && set -o pipefail; false | true"],
    { timeout: PROBE_TIMEOUT_MS },
  );
  if (!pipefailProbe.error && pipefailProbe.status !== 0) {
    return { capability: "pipefail" };
  }
  return { capability: "none" };
}

export function parsePipeSegments(text: string): readonly number[] | undefined {
  const codes = text
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .map((token) => Number.parseInt(token, 10));
  if (codes.length === 0 || codes.some((code) => !Number.isFinite(code))) {
    return undefined;
  }
  return codes;
}

export function buildSegmentCaptureWrapper(
  command: string,
  segmentArray: PipeSegmentArray,
): string {
  const capture = `__roll_pipe_status="\${${segmentArray}[*]:-}"`;
  const write = `[ -n "\${${PIPE_STATUS_ENV}:-}" ] && printf "%s\\n" "$__roll_pipe_status" >"\${${PIPE_STATUS_ENV}}" 2>/dev/null`;
  return `trap '${capture}; ${write}' EXIT; ${command}`;
}

export interface PipelineVerdict {
  readonly ok: boolean;
  readonly effectiveExitCode: number;
  readonly note?: string;
}

export const SIGPIPE_BENIGN_NOTE =
  "管道中有上游阶段被下游提前关闭（SIGPIPE，退出码 141），按良性处理；下游输出可能不完整";
export const SIGPIPE_FALLBACK_NOTE =
  "退出码 141：上游被下游提前关闭（SIGPIPE），输出可能完整；当前 shell 无逐段状态，未视为失败";

export function evaluatePipelineExit(params: {
  readonly exitCode: number;
  readonly segments?: readonly number[];
  readonly capability: ShellPipeCapability;
}): PipelineVerdict {
  const segments = params.segments;
  if (params.capability === "segments" && segments !== undefined && segments.length > 0) {
    const last = segments[segments.length - 1] ?? params.exitCode;
    if (last !== params.exitCode) {
      return judgeByExitCode(params.exitCode);
    }
    const others = segments.slice(0, -1);
    const benignOthers = others.every((code) => code === 0 || code === SIGPIPE_EXIT_CODE);
    const hadSigpipe = others.some((code) => code === SIGPIPE_EXIT_CODE);
    if (last === 0 && benignOthers) {
      return {
        ok: true,
        effectiveExitCode: 0,
        ...(hadSigpipe ? { note: SIGPIPE_BENIGN_NOTE } : {}),
      };
    }
    const culprit = others.find((code) => code !== 0 && code !== SIGPIPE_EXIT_CODE);
    return {
      ok: false,
      effectiveExitCode: culprit !== undefined ? culprit : last,
    };
  }
  return judgeByExitCode(params.exitCode);
}

function judgeByExitCode(exitCode: number): PipelineVerdict {
  if (exitCode === 0) {
    return { ok: true, effectiveExitCode: 0 };
  }
  if (exitCode === SIGPIPE_EXIT_CODE) {
    return { ok: true, effectiveExitCode: SIGPIPE_EXIT_CODE, note: SIGPIPE_FALLBACK_NOTE };
  }
  return { ok: false, effectiveExitCode: exitCode };
}
