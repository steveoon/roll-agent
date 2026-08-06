import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h, type ReactElement, useRef } from "react";
import { Box, Text } from "ink";
import type { DOMElement } from "ink";
import { render } from "ink-testing-library";
import { useDeferredBoxMetrics } from "./deferred-box-metrics.ts";

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(10);
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  assert.fail("Timed out waiting for assertion");
}

function GrowingBox(): ReactElement {
  const ref = useRef<DOMElement | null>(null);
  const metrics = useDeferredBoxMetrics(ref);
  const lineCount = metrics.hasMeasured ? Math.min(metrics.height + 1, 60) : 1;
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
  const { lastFrame, unmount } = render(h(GrowingBox));
  try {
    await waitFor(() => {
      assert.match(lastFrame() ?? "", /line 60/);
    });
    assert.equal(
      errors.some((message) => message.includes("Maximum update depth exceeded")),
      false,
    );
  } finally {
    unmount();
  }
});
