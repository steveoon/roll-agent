import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useStdout } from "ink";
import type { DOMElement } from "ink";

const EMPTY_METRICS = {
  height: 0,
  top: 0,
  hasMeasured: false,
};

/**
 * Measure an Ink element after the current React commit has fully unwound.
 *
 * Ink's useBoxMetrics updates state synchronously from resetAfterCommit. A layout feedback loop can
 * therefore recurse through nested commits and hit React's maximum update depth. Coalescing reads
 * into the next macrotask keeps resize and local-render measurements current without updating React
 * from inside the renderer commit.
 */
export function useDeferredBoxMetrics(ref: RefObject<DOMElement | null>) {
  const { stdout } = useStdout();
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const measure = useCallback((): void => {
    const node = ref.current;
    const layout = node?.yogaNode?.getComputedLayout();
    const next = {
      height: layout?.height ?? 0,
      top: layout?.top ?? 0,
      hasMeasured: node !== null,
    };
    setMetrics((current) =>
      current.height === next.height &&
      current.top === next.top &&
      current.hasMeasured === next.hasMeasured
        ? current
        : next,
    );
  }, [ref]);

  const scheduleMeasurement = useCallback((): void => {
    if (pendingTimerRef.current !== undefined) {
      return;
    }
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = undefined;
      measure();
    }, 0);
  }, [measure]);

  useEffect(() => {
    scheduleMeasurement();
  });

  useEffect(() => {
    stdout.on("resize", scheduleMeasurement);
    return () => {
      stdout.off("resize", scheduleMeasurement);
    };
  }, [scheduleMeasurement, stdout]);

  useEffect(
    () => () => {
      if (pendingTimerRef.current !== undefined) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = undefined;
      }
    },
    [],
  );

  return metrics;
}
