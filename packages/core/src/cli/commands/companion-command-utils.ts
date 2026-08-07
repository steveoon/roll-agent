import { createDefaultCompanionApplication } from "../../companion-host/application.ts";
import { log } from "../utils/output.ts";

export function createCompanionCliApplication() {
  return createDefaultCompanionApplication();
}

export async function runCompanionCommand(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error: unknown) {
    log.error(error instanceof Error ? error.message : "Roll Companion command failed");
    process.exitCode = 1;
  }
}

export function createProcessAbortController(): {
  readonly controller: AbortController;
  readonly release: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Companion process was asked to stop"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    controller,
    release: () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}
