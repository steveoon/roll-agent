import { performance } from "node:perf_hooks";
import type { ManagedSession, SessionPollResult } from "./types.ts";

const POST_EXIT_FLUSH_MAX_MS = 250;

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

export async function pollUntilDeadline(
  session: ManagedSession,
  deadlineMs: number,
  maxChars: number,
): Promise<SessionPollResult> {
  const remaining = deadlineMs - performance.now();
  if (session.exitCode === undefined && remaining > 0) {
    const deadline = sleep(remaining);
    await Promise.race([session.waitExit(), deadline.promise]);
    deadline.cancel();
  }

  if (session.exitCode !== undefined) {
    const flushCap = sleep(POST_EXIT_FLUSH_MAX_MS);
    await Promise.race([session.waitClose(), flushCap.promise]);
    flushCap.cancel();
  }

  session.lastUsedAt = performance.now();
  const drained = session.buffer.drain(maxChars);
  const wallTimeMs = performance.now() - session.startedAt;

  if (session.exitCode !== undefined) {
    return {
      kind: "exited",
      output: drained.text,
      omitted: drained.omitted,
      wallTimeMs,
      exitCode: session.exitCode,
    };
  }
  return {
    kind: "running",
    output: drained.text,
    omitted: drained.omitted,
    wallTimeMs,
    sessionId: session.id,
  };
}
