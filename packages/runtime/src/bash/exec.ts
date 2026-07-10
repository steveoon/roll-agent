import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { OutputSink } from "./output-buffer.ts";
import {
  BASH_TERMINATION_CAUSES,
  EXEC_TIMEOUT_EXIT_CODE,
  normalizeExitCode,
  type BashExecResult,
  type BashTerminationCause,
} from "./format-result.ts";
import type { ShellProfile } from "./profile.ts";
import { isTimeoutAbortReason } from "../types/cancellation.ts";

const IO_DRAIN_TIMEOUT_MS = 2_000;
const KILL_TREE_DEADLINE_MS = 2_500;
const ROOT_KILL_SETTLE_TIMEOUT_MS = 1_000;
const ABORTED_EXIT_CODE = 130;

interface RunBashCommandDeps {
  readonly spawn: typeof spawn;
  readonly killTreeDeadlineMs: number;
  readonly rootKillSettleTimeoutMs: number;
  readonly ioDrainTimeoutMs?: number;
}

const DEFAULT_RUN_BASH_COMMAND_DEPS: RunBashCommandDeps = {
  spawn,
  killTreeDeadlineMs: KILL_TREE_DEADLINE_MS,
  rootKillSettleTimeoutMs: ROOT_KILL_SETTLE_TIMEOUT_MS,
};

export type BashStreamName = "stdout" | "stderr";

export interface RunBashOptions {
  readonly command: string;
  readonly workdir: string;
  readonly timeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly profile: ShellProfile;
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

function abortedResult(timeoutMs: number, reason: unknown): BashExecResult {
  const empty = new OutputSink(0).collect();
  const timedOut = isTimeoutAbortReason(reason);
  return {
    exitCode: timedOut ? EXEC_TIMEOUT_EXIT_CODE : ABORTED_EXIT_CODE,
    timedOut,
    timeoutMs,
    wallTimeMs: 0,
    stdout: empty,
    stderr: empty,
    terminationCause: timedOut ? BASH_TERMINATION_CAUSES.timeout : BASH_TERMINATION_CAUSES.abort,
  };
}

interface WiredStream {
  readonly stream: Readable;
  readonly closed: Promise<void>;
}

export function runBashCommand(
  options: RunBashOptions,
  deps: RunBashCommandDeps = DEFAULT_RUN_BASH_COMMAND_DEPS,
): Promise<BashExecResult> {
  const { command, workdir, timeoutMs, maxCaptureBytes, profile, env, abortSignal, onDelta } =
    options;

  return new Promise<BashExecResult>((resolve) => {
    if (abortSignal?.aborted) {
      resolve(abortedResult(timeoutMs, abortSignal.reason));
      return;
    }
    if (!existsSync(workdir)) {
      resolve(spawnErrorResult(`工作目录不存在: ${workdir}`, timeoutMs));
      return;
    }

    let child: ChildProcess;
    try {
      const spec = profile.buildSpawn(command, workdir, env ?? process.env);
      child = deps.spawn(spec.file, spec.args, spec.options);
    } catch (error) {
      resolve(spawnErrorResult(errorMessage(error), timeoutMs));
      return;
    }

    const start = performance.now();
    const stdoutSink = new OutputSink(maxCaptureBytes);
    const stderrSink = new OutputSink(maxCaptureBytes);
    let timedOut = false;
    let aborted = false;
    let terminationCause: BashTerminationCause | undefined;
    let killed = false;
    let settled = false;
    let exitObserved = false;
    let streamsDrained = false;
    let observedExitCode: number | null = null;
    let observedExitSignal: NodeJS.Signals | null = null;
    let processStarted = child.pid !== undefined;
    let rootFallbackStarted = false;
    let killTreeSucceeded = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let killController: AbortController | undefined;
    let killTreeDeadlineTimer: NodeJS.Timeout | undefined;
    let rootKillSettleTimer: NodeJS.Timeout | undefined;
    let terminationError: string | undefined;

    const appendTerminationError = (message: string): void => {
      terminationError = terminationError ? `${terminationError}；${message}` : message;
    };

    const tryFinishFromExit = (): void => {
      if (settled || !exitObserved || !streamsDrained) {
        return;
      }
      if (
        killed &&
        profile.waitForTreeKillAfterRootExit === true &&
        !rootFallbackStarted &&
        !killTreeSucceeded
      ) {
        return;
      }
      const signalNumber =
        observedExitSignal !== null ? constants.signals[observedExitSignal] : undefined;
      const exitCode = timedOut
        ? EXEC_TIMEOUT_EXIT_CODE
        : aborted
          ? ABORTED_EXIT_CODE
          : normalizeExitCode({
              timedOut: false,
              code: observedExitCode,
              signalNumber,
            });
      finish({
        exitCode,
        timedOut,
        timeoutMs,
        wallTimeMs: performance.now() - start,
        stdout: stdoutSink.collect(),
        stderr: stderrSink.collect(),
        ...(terminationCause ? { terminationCause } : {}),
        ...(terminationError ? { terminationError } : {}),
      });
    };

    const finishAfterRootKillFallback = (): void => {
      if (settled || exitObserved) {
        return;
      }
      for (const entry of wired) {
        entry.stream.destroy();
      }
      child.unref();
      finish({
        exitCode: timedOut ? EXEC_TIMEOUT_EXIT_CODE : ABORTED_EXIT_CODE,
        timedOut,
        timeoutMs,
        wallTimeMs: performance.now() - start,
        stdout: stdoutSink.collect(),
        stderr: stderrSink.collect(),
        ...(terminationCause ? { terminationCause } : {}),
        terminationError: `${terminationError ?? "进程树清理未完成"}；根进程在强制终止请求后仍未确认退出`,
      });
    };

    const fallbackKillRoot = (reason?: unknown): void => {
      if (settled) {
        return;
      }
      if (killTreeDeadlineTimer) {
        clearTimeout(killTreeDeadlineTimer);
        killTreeDeadlineTimer = undefined;
      }
      if (!rootFallbackStarted) {
        rootFallbackStarted = true;
        const failure = reason === undefined ? "进程树清理未完成" : errorMessage(reason);
        appendTerminationError(
          `${failure}；已回退仅向根进程发送强制终止请求，无法确认后代进程是否已清理`,
        );
      }
      if (exitObserved) {
        tryFinishFromExit();
        return;
      }
      if (rootKillSettleTimer !== undefined) {
        return;
      }
      rootKillSettleTimer = setTimeout(finishAfterRootKillFallback, deps.rootKillSettleTimeoutMs);
      try {
        if (!child.kill("SIGKILL")) {
          appendTerminationError("根进程强制终止请求未被接受");
        }
      } catch (error) {
        appendTerminationError(`根进程强制终止请求失败: ${errorMessage(error)}`);
      }
    };

    const escalateKill = (): void => {
      if (killed) {
        return;
      }
      killed = true;
      killController = new AbortController();
      killTreeDeadlineTimer = setTimeout(
        () => fallbackKillRoot(new Error("进程树清理超过独立期限")),
        deps.killTreeDeadlineMs,
      );
      try {
        profile
          .killTree(child.pid, "terminate", { signal: killController.signal })
          .then(() => {
            killTreeSucceeded = true;
            if (exitObserved && killTreeDeadlineTimer) {
              clearTimeout(killTreeDeadlineTimer);
              killTreeDeadlineTimer = undefined;
            }
            tryFinishFromExit();
          })
          .catch(fallbackKillRoot);
      } catch (error) {
        fallbackKillRoot(error);
      }
    };

    const onAbort = (): void => {
      if (terminationCause !== undefined) {
        return;
      }
      const timeoutAbort = isTimeoutAbortReason(abortSignal?.reason);
      terminationCause = timeoutAbort
        ? BASH_TERMINATION_CAUSES.timeout
        : BASH_TERMINATION_CAUSES.abort;
      timedOut = timeoutAbort;
      aborted = !timeoutAbort;
      clearTimeout(timeoutTimer);
      escalateKill();
    };

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (drainTimer) {
        clearTimeout(drainTimer);
      }
      if (killTreeDeadlineTimer) {
        clearTimeout(killTreeDeadlineTimer);
      }
      if (rootKillSettleTimer) {
        clearTimeout(rootKillSettleTimer);
      }
      killController?.abort();
      killController = undefined;
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

    child.once("spawn", () => {
      processStarted = true;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      if (!killed || !processStarted) {
        finish(spawnErrorResult(errorMessage(error), timeoutMs));
        return;
      }
      const message = `根进程终止请求失败: ${errorMessage(error)}`;
      if (rootFallbackStarted) {
        appendTerminationError(message);
      } else {
        fallbackKillRoot(new Error(message, { cause: error }));
      }
    });

    child.on("exit", (code, signal) => {
      if (settled || exitObserved) {
        return;
      }
      exitObserved = true;
      observedExitCode = code;
      observedExitSignal = signal;
      clearTimeout(timeoutTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (killTreeSucceeded && killTreeDeadlineTimer) {
        clearTimeout(killTreeDeadlineTimer);
        killTreeDeadlineTimer = undefined;
      }
      if (rootKillSettleTimer) {
        clearTimeout(rootKillSettleTimer);
        rootKillSettleTimer = undefined;
      }
      drainTimer = setTimeout(() => {
        for (const entry of wired) {
          entry.stream.destroy();
        }
      }, deps.ioDrainTimeoutMs ?? IO_DRAIN_TIMEOUT_MS);

      Promise.all(wired.map((entry) => entry.closed))
        .then(() => {
          streamsDrained = true;
          tryFinishFromExit();
        })
        .catch(() => {});
    });

    const timeoutTimer = setTimeout(() => {
      if (terminationCause !== undefined) {
        return;
      }
      terminationCause = BASH_TERMINATION_CAUSES.timeout;
      timedOut = true;
      escalateKill();
    }, timeoutMs);

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort);
      }
    }
  });
}
