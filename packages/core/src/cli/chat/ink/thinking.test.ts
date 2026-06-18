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

test("thinkingLabel renders the brain glyph", () => {
  assert.equal(thinkingLabel("medium"), "🧠 medium");
  assert.equal(thinkingLabel("off"), "🧠 off");
});
