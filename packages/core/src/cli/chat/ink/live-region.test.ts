import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { LiveRegion, reasoningTail } from "./live-region.ts";
import type { LiveState } from "./state.ts";

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

test("LiveRegion renders streaming assistant text as Markdown preview", () => {
  const live: LiveState = {
    streamingText: "## 流式标题\n\n**正在加粗**\n\n- 第一项",
    reasoningId: undefined,
    reasoningText: "",
    reasoningActive: false,
    thinkTagOpen: false,
    activeTools: [],
    compacting: false,
    producedOutput: true,
  };
  const { lastFrame, unmount } = render(h(LiveRegion, { live }));
  try {
    const frame = stripVTControlCharacters(lastFrame() ?? "");
    assert.match(frame, /流式标题/);
    assert.match(frame, /正在加粗/);
    assert.match(frame, /• 第一项/);
    assert.doesNotMatch(frame, /## |\*\*/);
  } finally {
    unmount();
  }
});

test("LiveRegion keeps thinking dim while previewing visible Markdown", () => {
  const live: LiveState = {
    streamingText: "<think>内部推理</think>**最终答案**",
    reasoningId: undefined,
    reasoningText: "",
    reasoningActive: false,
    thinkTagOpen: false,
    activeTools: [],
    compacting: false,
    producedOutput: true,
  };
  const { lastFrame, unmount } = render(h(LiveRegion, { live }));
  const frame = lastFrame() ?? "";
  assert.match(frame, /内部推理/);
  assert.match(frame, /最终答案/);
  assert.doesNotMatch(frame, /<\/?think>|\*\*/);
  unmount();
});
