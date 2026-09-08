import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, type ReactElement, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { DOMElement } from "ink";
import { render } from "ink-testing-library";
import { useDeferredBoxMetrics } from "./deferred-box-metrics.ts";

const TARGET_HEIGHT = 60;

function GrowingBox({
  onMeasured,
}: {
  readonly onMeasured: (height: number) => void;
}): ReactElement {
  const ref = useRef<DOMElement | null>(null);
  const metrics = useDeferredBoxMetrics(ref);
  const lineCount = metrics.hasMeasured ? Math.min(metrics.height + 1, TARGET_HEIGHT) : 1;
  useEffect(() => {
    if (metrics.hasMeasured) onMeasured(metrics.height);
  }, [metrics.hasMeasured, metrics.height, onMeasured]);
  return h(
    Box,
    { ref, flexDirection: "column" },
    ...Array.from({ length: lineCount }, (_, index) =>
      h(Text, { key: index }, `line ${String(index + 1)}`),
    ),
  );
}

test("deferred box metrics do not recurse through React commits", async (context) => {
  const errors: string[] = [];
  context.mock.method(console, "error", (...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  });
  // Every extra line requires another deferred measurement/React commit. CI contention may
  // delay those 60 macrotasks; completion is the settled measurement, not a 3-second speed target.
  const completed = Promise.withResolvers<void>();
  let measuredHeight = 0;
  const onMeasured = (height: number): void => {
    measuredHeight = height;
    if (height === TARGET_HEIGHT) completed.resolve();
  };
  const { lastFrame, unmount } = render(h(GrowingBox, { onMeasured }));
  const timeout = setTimeout(() => {
    completed.reject(
      new Error(`Measurement did not settle at ${TARGET_HEIGHT} lines (last: ${measuredHeight})`),
    );
  }, 10_000);
  context.after(() => {
    clearTimeout(timeout);
    unmount();
  });
  await completed.promise;
  assert.match(lastFrame() ?? "", /line 60/);
  assert.equal(
    errors.some((message) => message.includes("Maximum update depth exceeded")),
    false,
  );
});
