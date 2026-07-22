import { test } from "node:test";
import assert from "node:assert/strict";
import { reasoningTail } from "./live-region.ts";

test("reasoningTail keeps short reasoning intact", () => {
  assert.equal(reasoningTail("先定位代码路径"), "先定位代码路径");
});

test("reasoningTail clamps long reasoning to the latest lines with a leading ellipsis", () => {
  const text = ["第一步", "第二步", "第三步", "第四步", "第五步"].join("\n");
  assert.equal(reasoningTail(text), "…\n第三步\n第四步\n第五步");
});

test("reasoningTail drops blank lines so the preview stays dense", () => {
  assert.equal(reasoningTail("定位问题\n\n   \n修复边界\n"), "定位问题\n修复边界");
});
