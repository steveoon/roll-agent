import { test } from "node:test";
import assert from "node:assert/strict";
import { displayWidth } from "./display-width.ts";

test("displayWidth follows terminal width for text and grapheme clusters", () => {
  const cases = [
    ["abc", 3],
    ["中文", 4],
    ["·", 1],
    ["中·文", 5],
    ["é", 1],
    ["👍🏽", 2],
    ["👩‍👩‍👧‍👦", 2],
    ["🇨🇳", 2],
    ["♥︎", 1],
    ["♥️", 2],
  ] as const;
  for (const [text, expected] of cases) {
    assert.equal(displayWidth(text), expected, text);
  }
});
