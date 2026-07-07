import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { OutputSink } from "./output-buffer.ts";
import { normalizeExitCode, type BashExecResult } from "./format-result.ts";
import { escalateKillGroup } from "./kill.ts";

const IO_DRAIN_TIMEOUT_MS = 2_000;

export type BashStreamName = "stdout" | "stderr";

export interface RunBashOptions {
  readonly command: string;
  readonly workdir: string;
  readonly timeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly shell: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly abortSignal?: AbortSignal;
  readonly onDelta?: (stream: BashStreamName, delta: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnErrorResult(message: string, timeoutMs: number): BashExecResult {
  const empty = new OutputSink(0).collect();
  return {
    exitCode: 1,
    timedOut: false,
    timeoutMs,
    wallTimeMs: 0,
    stdout: empty,
    stderr: empty,
    spawnError: message,
  };
}

interface WiredStream {
  readonly stream: Readable;
  readonly closed: Promise<void>;
}

export function runBashCommand(options: RunBashOptions): Promise<BashExecResult> {
  const { command, workdir, timeoutMs, maxCaptureBytes, shell, env, abortSignal, onDelta } =
    options;

  return new Promise<BashExecResult>((resolve) => {
    if (!existsSync(workdir)) {
      resolve(spawnErrorResult(`工作目录不存在: ${workdir}`, timeoutMs));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(shell, ["-c", command], {
        cwd: workdir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(env ? { env } : {}),
      });
    } catch (error) {
      resolve(spawnErrorResult(errorMessage(error), timeoutMs));
      return;
    }

    const start = performance.now();
    const stdoutSink = new OutputSink(maxCaptureBytes);
    const stderrSink = new OutputSink(maxCaptureBytes);
    let timedOut = false;
    let killed = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const escalateKill = (): void => {
      if (killed) {
        return;
      }
      killed = true;
      graceTimer = escalateKillGroup(child.pid);
    };

    const onAbort = (): void => escalateKill();

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      if (drainTimer) {
        clearTimeout(drainTimer);
      }
      abortSignal?.removeEventListener("abort", onAbort);
    };

    const finish = (result: BashExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const wireStream = (
      stream: Readable | null,
      name: BashStreamName,
      sink: OutputSink,
    ): WiredStream | undefined => {
      if (stream === null) {
        return undefined;
      }
      const decoder = new TextDecoder("utf-8");
      stream.on("data", (chunk: Buffer) => {
        sink.append(chunk);
        if (onDelta) {
          const text = decoder.decode(chunk, { stream: true });
          if (text.length > 0) {
            onDelta(name, text);
          }
        }
      });
      const closed = new Promise<void>((resolve) => {
        stream.once("close", () => resolve());
      });
      return { stream, closed };
    };

    const wired = [
      wireStream(child.stdout, "stdout", stdoutSink),
      wireStream(child.stderr, "stderr", stderrSink),
    ].filter((entry): entry is WiredStream => entry !== undefined);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      escalateKill();
    }, timeoutMs);

    if (abortSignal) {
      if (abortSignal.aborted) {
        escalateKill();
      } else {
        abortSignal.addEventListener("abort", onAbort);
      }
    }

    child.on("error", (error) => finish(spawnErrorResult(errorMessage(error), timeoutMs)));

    child.on("exit", (code, signal) => {
      drainTimer = setTimeout(() => {
        for (const entry of wired) {
          entry.stream.destroy();
        }
      }, IO_DRAIN_TIMEOUT_MS);

      Promise.all(wired.map((entry) => entry.closed))
        .then(() => {
          const signalNumber = signal !== null ? constants.signals[signal] : undefined;
          finish({
            exitCode: normalizeExitCode({ timedOut, code, signalNumber }),
            timedOut,
            timeoutMs,
            wallTimeMs: performance.now() - start,
            stdout: stdoutSink.collect(),
            stderr: stderrSink.collect(),
          });
        })
        .catch(() => {});
    });
  });
}
