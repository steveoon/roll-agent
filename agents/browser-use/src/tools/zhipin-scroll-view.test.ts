import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zhipinScrollView } from "./zhipin-scroll-view.ts";

describe("zhipin_scroll_view", () => {
  it("defaults to a single bounded scroll step", () => {
    const parsed = zhipinScrollView.input.parse({ surface: "chat-list" });

    assert.equal(parsed.surface, "chat-list");
    assert.equal(parsed.steps, 1);
    assert.equal(parsed.settleMs, 700);
  });
});
