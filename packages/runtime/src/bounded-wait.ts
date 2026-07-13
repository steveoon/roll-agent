/**
 * Wait for a promise to settle within a bounded interval.
 *
 * Fulfilment and rejection both mean the observed work has settled. The caller remains
 * responsible for handling the promise's domain error before or after using this timing guard.
 */
export function waitForPromiseSettlement(
  promise: PromiseLike<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}
