import { test } from "node:test";
import assert from "node:assert/strict";
import { STOP_SIGNALS, installStopSignals } from "./stop-signals.ts";

test("installStopSignals 监听 SIGINT/SIGTERM/SIGHUP/SIGBREAK，首个信号 abort，重复信号只回调 onRepeat", () => {
  const listeners = new Map<string, () => void>();
  const target = {
    on: (signal: NodeJS.Signals, listener: () => void) => {
      listeners.set(signal, listener);
      return target;
    },
    off: (signal: NodeJS.Signals) => {
      listeners.delete(signal);
      return target;
    },
  } as unknown as Pick<NodeJS.Process, "on" | "off">;
  let stops = 0;
  let repeats = 0;
  const handle = installStopSignals(
    () => {
      stops += 1;
    },
    () => {
      repeats += 1;
    },
    target,
  );
  assert.deepEqual([...listeners.keys()].sort(), [...STOP_SIGNALS].sort());
  listeners.get("SIGHUP")?.();
  assert.equal(handle.controller.signal.aborted, true);
  assert.equal(stops, 1);
  listeners.get("SIGBREAK")?.();
  assert.equal(stops, 1);
  assert.equal(repeats, 1);
  handle.release();
  assert.equal(listeners.size, 0);
});
