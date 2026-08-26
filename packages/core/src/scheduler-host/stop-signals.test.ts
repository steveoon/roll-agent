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
  const stops: string[] = [];
  const repeats: string[] = [];
  const handle = installStopSignals(
    (signal) => {
      stops.push(signal);
      return signal === "SIGHUP" ? "urgent" : undefined;
    },
    (signal) => {
      repeats.push(signal);
    },
    target,
  );
  assert.deepEqual([...listeners.keys()].sort(), ["SIGBREAK", "SIGHUP", "SIGINT", "SIGTERM"]);
  assert.deepEqual([...STOP_SIGNALS].sort(), ["SIGBREAK", "SIGHUP", "SIGINT", "SIGTERM"]);
  listeners.get("SIGHUP")?.();
  assert.equal(handle.controller.signal.aborted, true);
  assert.equal(handle.controller.signal.reason, "urgent");
  assert.deepEqual(stops, ["SIGHUP"]);
  listeners.get("SIGBREAK")?.();
  assert.deepEqual(stops, ["SIGHUP"]);
  assert.deepEqual(repeats, ["SIGBREAK"]);
  handle.release();
  assert.equal(listeners.size, 0);
});
