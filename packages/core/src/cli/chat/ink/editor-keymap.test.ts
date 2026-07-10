import { test } from "node:test";
import assert from "node:assert/strict";
import type { Key } from "ink";
import { applyEditorCommand, resolveEditorCommand } from "./editor-keymap.ts";
import { createLineBuffer } from "./line-buffer.ts";

const BASE_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

function keyWith(overrides: Partial<Key>): Key {
  return { ...BASE_KEY, ...overrides };
}

test("resolveEditorCommand maps every binding to its command", () => {
  const cases: ReadonlyArray<readonly [string, Partial<Key>, string]> = [
    ["", { leftArrow: true }, "move-left"],
    ["", { rightArrow: true }, "move-right"],
    ["", { leftArrow: true, ctrl: true }, "move-word-left"],
    ["", { leftArrow: true, meta: true }, "move-word-left"],
    ["b", { meta: true }, "move-word-left"],
    ["", { rightArrow: true, ctrl: true }, "move-word-right"],
    ["", { rightArrow: true, meta: true }, "move-word-right"],
    ["f", { meta: true }, "move-word-right"],
    ["", { home: true }, "move-line-start"],
    ["a", { ctrl: true }, "move-line-start"],
    ["", { end: true }, "move-line-end"],
    ["e", { ctrl: true }, "move-line-end"],
    ["", { upArrow: true }, "move-up"],
    ["", { downArrow: true }, "move-down"],
    ["", { backspace: true }, "delete-backward"],
    ["", { delete: true }, "delete-forward"],
    ["w", { ctrl: true }, "delete-word-backward"],
    ["", { backspace: true, meta: true }, "delete-word-backward"],
    ["", { backspace: true, ctrl: true }, "delete-word-backward"],
    ["u", { ctrl: true }, "kill-line-start"],
    ["k", { ctrl: true }, "kill-line-end"],
  ];
  for (const [input, overrides, expected] of cases) {
    assert.equal(resolveEditorCommand(input, keyWith(overrides)), expected, expected);
  }
});

test("resolveEditorCommand ignores shift and uppercase input", () => {
  assert.equal(resolveEditorCommand("", keyWith({ leftArrow: true, shift: true })), "move-left");
  assert.equal(resolveEditorCommand("B", keyWith({ meta: true })), "move-word-left");
});

test("resolveEditorCommand returns undefined for unbound keys", () => {
  const cases: ReadonlyArray<readonly [string, Partial<Key>]> = [
    ["x", {}],
    ["j", { ctrl: true }],
    ["", { tab: true }],
    ["", { tab: true, shift: true }],
    ["", { return: true }],
    ["", { escape: true }],
    ["ab", {}],
    ["你好", {}],
    [".", { meta: true }],
    [",", { meta: true }],
    ["", {}],
  ];
  for (const [input, overrides] of cases) {
    assert.equal(resolveEditorCommand(input, keyWith(overrides)), undefined, input);
  }
});

test("applyEditorCommand dispatches to line buffer transforms", () => {
  const state = createLineBuffer("ab", 1);
  assert.equal(applyEditorCommand("move-left", state).cursor, 0);
  assert.equal(applyEditorCommand("move-right", state).cursor, 2);
  assert.equal(applyEditorCommand("delete-backward", state).value, "b");
});
