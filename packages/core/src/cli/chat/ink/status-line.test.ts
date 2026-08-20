import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { composeStatusSegments, StatusLine } from "./status-line.ts";
import type { StatusState } from "./state.ts";

const BUSY_STATUS: StatusState = {
  model: "qwen3.7-plus",
  contextWindow: 1_000_000,
  turnUsage: {
    inputTokens: 215_200,
    outputTokens: 307,
    cachedInputTokens: 106_400,
    reasoningTokens: 128,
  },
  sessionUsage: { totalTokens: 374_500 },
  contextInputTokens: 107_700,
  outputTokensPerSecond: 43.2,
  thinkingLevel: "medium",
  autoApprove: false,
};

function joined(status: StatusState, width: number): string {
  return composeStatusSegments(status, width)
    .map((segment) => segment.text)
    .join(" · ");
}

test("composeStatusSegments uses full labels on a wide terminal", () => {
  const line = joined(BUSY_STATUS, 200);
  assert.match(line, /qwen3\.7-plus/);
  assert.match(line, /🧠 medium/);
  assert.match(line, /ctx 107\.7k\/1M \(\d+% left\)/);
  assert.match(line, /turn in 215\.2k \(\+106\.4k cached\) out 307 \(\+128 reasoning\)/);
  assert.match(line, /43 tok\/s/);
  assert.match(line, /session 374\.5k/);
});

test("composeStatusSegments switches to compact labels when full does not fit", () => {
  const line = joined(BUSY_STATUS, 80);
  assert.match(line, /🧠 med/);
  assert.match(line, /ctx 107\.7k\/1M/);
  assert.match(line, /↑215\.2k ↓307/);
  assert.match(line, /43t\/s/);
  assert.match(line, /Σ374\.5k/);
  assert.doesNotMatch(line, /cached|reasoning|% left/);
});

test("composeStatusSegments drops low-priority segments on a narrow terminal", () => {
  const segments = composeStatusSegments(BUSY_STATUS, 40);
  const keys = segments.map((segment) => segment.key);
  assert.ok(keys.includes("model"));
  assert.ok(keys.includes("ctx"));
  assert.ok(!keys.includes("tps"));
  assert.ok(!keys.includes("session"));
});

test("composeStatusSegments colors context by pressure", () => {
  const critical: StatusState = {
    ...BUSY_STATUS,
    contextWindow: 200_000,
    contextInputTokens: 190_000,
  };
  const ctx = composeStatusSegments(critical, 200).find((segment) => segment.key === "ctx");
  assert.equal(ctx?.props.color, "red");
});

test("composeStatusSegments shows the auto badge only when enabled and never drops it", () => {
  const enabled: StatusState = { ...BUSY_STATUS, autoApprove: true };
  const wide = composeStatusSegments(enabled, 200).find((segment) => segment.key === "auto");
  assert.equal(wide?.text, "⏵⏵ auto-approve");
  assert.equal(wide?.props.color, "yellow");
  const narrow = composeStatusSegments(enabled, 40).find((segment) => segment.key === "auto");
  assert.equal(narrow?.text, "⏵⏵ auto");
  const disabled = composeStatusSegments(BUSY_STATUS, 200);
  assert.ok(!disabled.some((segment) => segment.key === "auto"));
});

test("composeStatusSegments omits usage segments before the first turn", () => {
  const idle: StatusState = {
    model: "qwen3.7-plus",
    contextWindow: 1_000_000,
    turnUsage: undefined,
    sessionUsage: undefined,
    contextInputTokens: undefined,
    outputTokensPerSecond: undefined,
    thinkingLevel: "medium",
    autoApprove: false,
  };
  const keys = composeStatusSegments(idle, 200).map((segment) => segment.key);
  assert.deepEqual(keys, ["model", "think"]);
});

test("StatusLine keeps a one-column gutter so the model id lines up with the prompt", () => {
  const { lastFrame, unmount } = render(h(StatusLine, { status: BUSY_STATUS, width: 40 }));
  const frame = lastFrame() ?? "";
  assert.match(frame, /^ qwen3\.7-plus/u);
  unmount();
});
