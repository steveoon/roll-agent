import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleThinking, thinkingLabel } from "./thinking.ts";

test("cycleThinking steps up and down through the levels", () => {
  assert.equal(cycleThinking("off", 1), "low");
  assert.equal(cycleThinking("low", 1), "medium");
  assert.equal(cycleThinking("medium", 1), "high");
  assert.equal(cycleThinking("high", -1), "medium");
});

test("cycleThinking clamps at the ends", () => {
  assert.equal(cycleThinking("high", 1), "high");
  assert.equal(cycleThinking("off", -1), "off");
});

test("cycleThinking follows model capabilities and skips unsupported off", () => {
  const levels = ["low", "medium", "high", "xhigh", "max"] as const;
  assert.equal(cycleThinking("low", -1, levels), "low");
  assert.equal(cycleThinking("high", 1, levels), "xhigh");
  assert.equal(cycleThinking("xhigh", 1, levels), "max");
  assert.equal(cycleThinking("max", 1, levels), "max");
  assert.equal(cycleThinking("high", 1, ["high", "max"]), "max");
  assert.equal(cycleThinking("medium", 1, []), "medium");
});

test("thinkingLabel renders the brain glyph", () => {
  assert.equal(thinkingLabel("medium"), "🧠 medium");
  assert.equal(thinkingLabel("off"), "🧠 off");
});
