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

export function installStopSignals(
  onStop: () => void,
  onRepeat: () => void,
  target: Pick<NodeJS.Process, "on" | "off"> = process,
): StopSignalHandle {
  const controller = new AbortController();
  const handler = () => {
    if (controller.signal.aborted) {
      onRepeat();
      return;
    }
    onStop();
    controller.abort(new Error("scheduler daemon was asked to stop"));
  };
  for (const signal of STOP_SIGNALS) {
    target.on(signal, handler);
  }
  return {
    controller,
    release: () => {
      for (const signal of STOP_SIGNALS) {
        target.off(signal, handler);
      }
    },
  };
}
