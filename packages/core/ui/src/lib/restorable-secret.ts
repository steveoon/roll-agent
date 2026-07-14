import { useEffect, useRef } from "react";
import { resolveSecretInputValue } from "../app-state.ts";

export function useRestorableSecretInput(
  configuredSecret: boolean,
  present: boolean,
): (nextValue: string) => string {
  const canRestoreExistingSecret = useRef(configuredSecret);

  useEffect(() => {
    if (configuredSecret) {
      canRestoreExistingSecret.current = true;
    } else if (!present) {
      canRestoreExistingSecret.current = false;
    }
  }, [configuredSecret, present]);

  return (nextValue: string): string =>
    resolveSecretInputValue(nextValue, canRestoreExistingSecret.current);
}
