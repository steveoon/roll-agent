export const STOP_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGBREAK",
] as const satisfies readonly NodeJS.Signals[];

export interface StopSignalHandle {
  readonly controller: AbortController;
  readonly release: () => void;
}

export type StopSignal = (typeof STOP_SIGNALS)[number];

export function installStopSignals(
  onStop: (signal: StopSignal) => unknown,
  onRepeat: (signal: StopSignal) => void,
  target: Pick<NodeJS.Process, "on" | "off"> = process,
): StopSignalHandle {
  const controller = new AbortController();
  const handlerFor = (signal: StopSignal) => () => {
    if (controller.signal.aborted) {
      onRepeat(signal);
      return;
    }
    const reason = onStop(signal);
    controller.abort(reason ?? new Error("scheduler daemon was asked to stop"));
  };
  const handlers = STOP_SIGNALS.map((signal) => [signal, handlerFor(signal)] as const);
  for (const [signal, handler] of handlers) {
    target.on(signal, handler);
  }
  return {
    controller,
    release: () => {
      for (const [signal, handler] of handlers) {
        target.off(signal, handler);
      }
    },
  };
}
