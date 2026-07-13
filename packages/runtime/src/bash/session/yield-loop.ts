import { performance } from "node:perf_hooks";
import {
  isTerminalSessionState,
  type ManagedSession,
  type SessionPollOptions,
  type SessionPollResult,
} from "./types.ts";

export class SessionPollInProgressError extends Error {
  constructor(sessionId: number) {
    super(`会话 ${String(sessionId)} 已有一个轮询窗口在运行`);
    this.name = "SessionPollInProgressError";
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException(
    typeof reason === "string" && reason.length > 0 ? reason : "The operation was aborted",
    "AbortError",
  );
}

export function throwIfSessionExecAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortError(signal);
  }
}

function waitForSettlementOrDeadline(
  session: ManagedSession,
  remainingMs: number,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (remainingMs <= 0 || isTerminalSessionState(session.state)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = (): void => finish(abortError(abortSignal));
    const timer = setTimeout(() => finish(), remainingMs);
    session.waitSettled().then(() => finish());
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted === true) {
      onAbort();
    }
  });
}

export async function pollUntilDeadline(
  session: ManagedSession,
  deadlineMs: number,
  maxChars: number,
  options: SessionPollOptions = {},
): Promise<SessionPollResult> {
  if (!session.beginPoll(options.onDelta)) {
    throw new SessionPollInProgressError(session.id);
  }

  try {
    throwIfSessionExecAborted(options.abortSignal);
    await waitForSettlementOrDeadline(session, deadlineMs - performance.now(), options.abortSignal);
    // Abort wins a completion race: do not consume output from a result the model will not receive.
    throwIfSessionExecAborted(options.abortSignal);

    const now = performance.now();
    session.lastUsedAt = now;
    const state = session.state;
    const terminal = isTerminalSessionState(state);
    const output = terminal ? session.buffer.snapshot(maxChars) : session.buffer.drain(maxChars);
    const wallTimeMs = (terminal ? (session.completedAt ?? now) : now) - session.startedAt;

    if (terminal) {
      return {
        kind: "exited",
        output: output.text,
        omitted: output.omitted,
        wallTimeMs,
        exitCode: session.exitCode ?? 1,
        state,
        ...(session.terminationCause ? { terminationCause: session.terminationCause } : {}),
        ...(session.cleanupError ? { cleanupError: session.cleanupError } : {}),
      };
    }
    return {
      kind: "running",
      output: output.text,
      omitted: output.omitted,
      wallTimeMs,
      sessionId: session.id,
    };
  } finally {
    session.lastUsedAt = performance.now();
    session.endPoll();
  }
}
