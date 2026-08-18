import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import type { BashStreamName } from "../exec.ts";
import { normalizeExitCode } from "../format-result.ts";
import {
  allocateOutputDumpFile,
  createOutputDumpWriter,
  OUTPUT_DUMP_SESSION_CAP_BYTES,
  rollOutputDumpDir,
  type OutputDumpWriter,
} from "../output-dump.ts";
import { parsePipeSegments } from "../shell-pipe.ts";
import { HeadTailBuffer } from "./head-tail-buffer.ts";
import {
  SESSION_STATES,
  type ManagedSession,
  type SessionDeltaHandler,
  type SessionTerminationCause,
  type SpawnSessionInput,
} from "./types.ts";

class Gate {
  private opened = false;
  private waiters: (() => void)[] = [];

  open(): void {
    if (this.opened) {
      return;
    }
    this.opened = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  wait(): Promise<void> {
    if (this.opened) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export function spawnSession(input: SpawnSessionInput): ManagedSession {
  const spec = input.profile.buildSpawn(input.command, input.workdir, input.env);
  const child: ChildProcess = spawn(spec.file, spec.args, spec.options);
  const segmentFile = spec.rollSegmentFile;
  const dumpWriter: OutputDumpWriter = createOutputDumpWriter(
    allocateOutputDumpFile(rollOutputDumpDir(), "session"),
    OUTPUT_DUMP_SESSION_CAP_BYTES,
  );

  const buffer = new HeadTailBuffer(input.bufferCapacity);
  const startedAt = performance.now();
  const exitGate = new Gate();
  const closeGate = new Gate();
  const settledGate = new Gate();
  let onDelta: SessionDeltaHandler | undefined = input.onDelta;
  let pollInProgress = false;

  const session: ManagedSession = {
    id: input.id,
    command: input.command,
    workdir: input.workdir,
    profile: input.profile,
    child,
    buffer,
    startedAt,
    state: SESSION_STATES.running,
    exitCode: undefined,
    exitObserved: false,
    closeObserved: false,
    completedAt: undefined,
    terminationCause: undefined,
    cleanupError: undefined,
    lastUsedAt: startedAt,
    pipeSegments: undefined,
    pipeCapability: input.profile.pipeCapability?.().capability,
    dumpPath: dumpWriter.path,
    beginPoll: (handler) => {
      if (pollInProgress) {
        return false;
      }
      pollInProgress = true;
      if (handler !== undefined) {
        onDelta = handler;
      }
      return true;
    },
    endPoll: () => {
      onDelta = undefined;
      pollInProgress = false;
    },
    markStopping: (cause: SessionTerminationCause) => {
      if (
        session.state === SESSION_STATES.completed ||
        session.state === SESSION_STATES.cleanupFailed
      ) {
        return;
      }
      session.terminationCause ??= cause;
      session.state = SESSION_STATES.stopping;
    },
    markCompleted: () => {
      if (session.state === SESSION_STATES.cleanupFailed) {
        return;
      }
      session.exitCode ??= 1;
      session.state = SESSION_STATES.completed;
      session.completedAt ??= performance.now();
      settledGate.open();
    },
    markCleanupFailed: (message: string) => {
      session.cleanupError = session.cleanupError ? `${session.cleanupError}；${message}` : message;
      session.exitCode ??= 1;
      session.state = SESSION_STATES.cleanupFailed;
      session.completedAt ??= performance.now();
      settledGate.open();
    },
    waitExit: () => exitGate.wait(),
    waitClose: () => closeGate.wait(),
    waitSettled: () => settledGate.wait(),
  };

  const appendDecoded = (name: BashStreamName, text: string): void => {
    if (text.length === 0) {
      return;
    }
    buffer.append(text);
    dumpWriter.write(text);
    onDelta?.(name, text);
  };

  const collectPipeSegments = (): void => {
    if (segmentFile === undefined) {
      return;
    }
    try {
      session.pipeSegments = parsePipeSegments(readFileSync(segmentFile, "utf8"));
    } catch {
      session.pipeSegments = undefined;
    } finally {
      try {
        unlinkSync(segmentFile);
      } catch {}
    }
  };

  const wireStream = (stream: Readable | null, name: BashStreamName): void => {
    if (stream === null) {
      return;
    }
    const decoder = new TextDecoder("utf-8");
    stream.on("data", (chunk: Buffer) => {
      appendDecoded(name, decoder.decode(chunk, { stream: true }));
    });
    stream.on("end", () => {
      appendDecoded(name, decoder.decode());
    });
  };
  wireStream(child.stdout, "stdout");
  wireStream(child.stderr, "stderr");

  const observeExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (session.exitObserved) {
      return;
    }
    const signalNumber = signal !== null ? constants.signals[signal] : undefined;
    session.exitCode = normalizeExitCode({ timedOut: false, code, signalNumber });
    session.exitObserved = true;
    if (session.state === SESSION_STATES.running) {
      session.state = SESSION_STATES.draining;
    }
    exitGate.open();
  };

  child.on("exit", (code, signal) => {
    observeExit(code, signal);
  });
  child.on("close", (code, signal) => {
    observeExit(code, signal);
    dumpWriter.close();
    collectPipeSegments();
    session.closeObserved = true;
    session.completedAt ??= performance.now();
    closeGate.open();
    if (session.state !== SESSION_STATES.stopping) {
      session.markCompleted();
    }
  });
  child.on("error", (error) => {
    buffer.append(`无法启动进程: ${error.message}\n`);
    session.exitCode = session.exitCode ?? 1;
    session.exitObserved = true;
    if (session.state === SESSION_STATES.running) {
      session.state = SESSION_STATES.draining;
    }
    exitGate.open();
  });

  return session;
}
