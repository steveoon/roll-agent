import { setTimeout as delay } from "node:timers/promises";
import type { GoalDriver } from "./loop.ts";

// NativeCdpController preserves the protocol message and appends its numeric
// code. Keep this allowlist exact: policy, navigation, timeout and transport
// failures are not evidence of a detached node and must not be retried.
const detachedNodeErrors = new Set([
  "Could not find node with given id (-32000)",
  "No node with given id found (-32000)",
]);

/** Retry only a complete readonly observation, never a browser action. */
export function createRetryingGoalObserver(
  read: GoalDriver["observe"],
  signal: AbortSignal,
  discardPartial?: () => void,
): GoalDriver["observe"] {
  return async (dependencyIdentities = []) => {
    const dependencies = [...dependencyIdentities];
    const attempt = async () => {
      signal.throwIfAborted();
      try {
        const snapshot = await read(dependencies);
        signal.throwIfAborted();
        return snapshot;
      } catch (error) {
        discardPartial?.();
        throw error;
      }
    };
    try {
      return await attempt();
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof Error) ||
        error.name !== "Error" ||
        Reflect.has(error, "code") ||
        !detachedNodeErrors.has(error.message)
      ) {
        throw error;
      }
      // Included in the caller's observation timing and cancellable throughout.
      await delay(50, undefined, { signal });
      return await attempt();
    }
  };
}
