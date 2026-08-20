import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISABLE_MOUSE_TRACKING,
  isMouseProtocolInput,
  parseMouseWheelInput,
} from "./mouse-input.ts";

test("disable 序列重置全部五种鼠标上报模式，覆盖崩溃残留", () => {
  for (const mode of ["1000", "1002", "1003", "1015", "1006"]) {
    assert.ok(
      DISABLE_MOUSE_TRACKING.includes(`[?${mode}l`),
      `missing reset for mode ${mode}`,
    );
  }
});

test("parseMouseWheelInput accepts Ink-normalized and raw SGR wheel input", () => {
  assert.deepEqual(parseMouseWheelInput("[<64;10;5M"), {
    direction: "up",
    column: 10,
    row: 5,
  });
  assert.deepEqual(parseMouseWheelInput("\u001B[<65;3;8M"), {
    direction: "down",
    column: 3,
    row: 8,
  });
  assert.equal(parseMouseWheelInput("[<66;3;8M"), undefined);
  assert.equal(parseMouseWheelInput("[<67;3;8M"), undefined);
});

test("mouse protocol detection filters non-wheel mouse bytes from the editor", () => {
  assert.equal(isMouseProtocolInput("[<0;10;5M"), true);
  assert.equal(parseMouseWheelInput("[<0;10;5M"), undefined);
  assert.equal(isMouseProtocolInput("ordinary text"), false);
});
