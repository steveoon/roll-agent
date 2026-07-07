import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import type { BashStreamName } from "../exec.ts";
import { normalizeExitCode } from "../format-result.ts";
import { HeadTailBuffer } from "./head-tail-buffer.ts";
import type { ManagedSession, SpawnSessionInput } from "./types.ts";

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
  const child: ChildProcess = spawn(input.shell, ["-c", input.command], {
    cwd: input.workdir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: input.env,
  });

  const buffer = new HeadTailBuffer(input.bufferCapacity);
  const startedAt = performance.now();
  const exitGate = new Gate();
  const closeGate = new Gate();

  const session: ManagedSession = {
    id: input.id,
    child,
    buffer,
    startedAt,
    exitCode: undefined,
    lastUsedAt: startedAt,
    onDelta: input.onDelta,
    waitExit: () => exitGate.wait(),
    waitClose: () => closeGate.wait(),
  };

  const wireStream = (stream: Readable | null, name: BashStreamName): void => {
    if (stream === null) {
      return;
    }
    const decoder = new TextDecoder("utf-8");
    stream.on("data", (chunk: Buffer) => {
      const text = decoder.decode(chunk, { stream: true });
      if (text.length > 0) {
        buffer.append(text);
        session.onDelta?.(name, text);
      }
    });
  };
  wireStream(child.stdout, "stdout");
  wireStream(child.stderr, "stderr");

  child.on("exit", (code, signal) => {
    const signalNumber = signal !== null ? constants.signals[signal] : undefined;
    session.exitCode = normalizeExitCode({ timedOut: false, code, signalNumber });
    exitGate.open();
  });
  child.on("close", () => {
    closeGate.open();
  });
  child.on("error", (error) => {
    buffer.append(`无法启动进程: ${error.message}\n`);
    session.exitCode = session.exitCode ?? 1;
    exitGate.open();
    closeGate.open();
  });

  return session;
}
