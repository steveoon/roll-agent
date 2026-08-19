import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIFF_INLINE_MAX_LINES,
  resolveDiffDisplayToggle,
  shouldExpandDiff,
} from "./diff-display.ts";

test("shouldExpandDiff：collapsed 下只展开不超过阈值的 diff，expanded 下全部展开", () => {
  assert.equal(shouldExpandDiff(DIFF_INLINE_MAX_LINES, "collapsed"), true);
  assert.equal(shouldExpandDiff(DIFF_INLINE_MAX_LINES + 1, "collapsed"), false);
  assert.equal(shouldExpandDiff(9_999, "expanded"), true);
});

test("resolveDiffDisplayToggle 解析 on/off/expanded/collapsed，其余切换", () => {
  assert.equal(resolveDiffDisplayToggle("on", "collapsed"), "expanded");
  assert.equal(resolveDiffDisplayToggle("expanded", "collapsed"), "expanded");
  assert.equal(resolveDiffDisplayToggle("off", "expanded"), "collapsed");
  assert.equal(resolveDiffDisplayToggle("collapsed", "expanded"), "collapsed");
  assert.equal(resolveDiffDisplayToggle("", "collapsed"), "expanded");
  assert.equal(resolveDiffDisplayToggle("", "expanded"), "collapsed");
});
