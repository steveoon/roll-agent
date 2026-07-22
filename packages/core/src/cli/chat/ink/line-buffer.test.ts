import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLineBuffer,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  graphemeAt,
  insertText,
  killToLineEnd,
  killToLineStart,
  moveDown,
  moveLeft,
  moveRight,
  moveToLineEnd,
  moveToLineStart,
  moveUp,
  moveVisualDown,
  moveVisualUp,
  moveWordLeft,
  moveWordRight,
} from "./line-buffer.ts";

const FAMILY = "👩‍👩‍👧‍👦";

test("createLineBuffer defaults cursor to end and clamps out-of-range", () => {
  assert.deepEqual(createLineBuffer("abc"), { value: "abc", cursor: 3, goalColumn: undefined });
  assert.equal(createLineBuffer("abc", 999).cursor, 3);
  assert.equal(createLineBuffer("abc", -5).cursor, 0);
});

test("createLineBuffer snaps mid-cluster cursor to grapheme boundary", () => {
  assert.equal(createLineBuffer(FAMILY, 5).cursor, 0);
  assert.equal(createLineBuffer(`a${FAMILY}b`, 6).cursor, 1);
});

test("insertText inserts at cursor including IME multi-char and newline", () => {
  const start = createLineBuffer("你好", 1);
  assert.deepEqual(insertText(start, "呀"), { value: "你呀好", cursor: 2, goalColumn: undefined });
  assert.equal(insertText(createLineBuffer("ab", 1), "\n").value, "a\nb");
  assert.equal(insertText(createLineBuffer(""), "多字符插入").value, "多字符插入");
  const noop = insertText(start, "");
  assert.deepEqual(noop, start);
});

test("insertText keeps the cursor on a grapheme boundary when insertion joins right text", () => {
  const cases = [
    { initial: "👧", at: 0, inserted: "👩‍", expected: "👩‍👧", cursor: 5 },
    { initial: "🇳", at: 0, inserted: "🇨", expected: "🇨🇳", cursor: 4 },
    { initial: "कष", at: 1, inserted: "्", expected: "क्ष", cursor: 3 },
  ] as const;
  for (const { initial, at, inserted, expected, cursor } of cases) {
    const next = insertText(createLineBuffer(initial, at), inserted);
    assert.deepEqual(next, { value: expected, cursor, goalColumn: undefined });
    assert.deepEqual(deleteBackward(next), { value: "", cursor: 0, goalColumn: undefined });
  }
});

test("deletion keeps the cursor on a grapheme boundary when remaining text joins", () => {
  const flagSource = "🇨x🇳";
  for (const next of [
    deleteForward(createLineBuffer(flagSource, 2)),
    deleteBackward(createLineBuffer(flagSource, 3)),
    deleteWordBackward(createLineBuffer(flagSource, 3)),
  ]) {
    assert.deepEqual(next, { value: "🇨🇳", cursor: 4, goalColumn: undefined });
  }

  assert.deepEqual(killToLineEnd(createLineBuffer("🇨\n🇳", 2)), {
    value: "🇨🇳",
    cursor: 4,
    goalColumn: undefined,
  });
  assert.deepEqual(killToLineEnd(createLineBuffer("\rx\n", 1)), {
    value: "\r\n",
    cursor: 2,
    goalColumn: undefined,
  });

  const combiningSource = "a\ń";
  for (const next of [
    deleteForward(createLineBuffer(combiningSource, 1)),
    deleteBackward(createLineBuffer(combiningSource, 2)),
    killToLineEnd(createLineBuffer(combiningSource, 1)),
  ]) {
    assert.deepEqual(next, { value: "á", cursor: 2, goalColumn: undefined });
  }
});

test("moveLeft and moveRight step over grapheme clusters", () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["ab", 1],
    ["你好", 1],
    [FAMILY, 11],
    ["é", 2],
    ["🇨🇳", 4],
    ["👍🏽", 4],
  ];
  for (const [text, clusterLength] of cases) {
    const atEnd = createLineBuffer(text);
    assert.equal(moveLeft(atEnd).cursor, text.length - clusterLength, text);
    const atStart = createLineBuffer(text, 0);
    assert.equal(moveRight(atStart).cursor, clusterLength, text);
  }
});

test("moveLeft at start and moveRight at end are no-ops", () => {
  const state = createLineBuffer("ab", 0);
  assert.equal(moveLeft(state).cursor, 0);
  assert.equal(moveRight(createLineBuffer("ab")).cursor, 2);
});

test("moveLeft crosses newline from line start", () => {
  const state = createLineBuffer("ab\ncd", 3);
  assert.equal(moveLeft(state).cursor, 2);
});

test("deleteBackward removes whole cluster before cursor", () => {
  const state = createLineBuffer(`${FAMILY}a`);
  const afterLetter = deleteBackward(state);
  assert.equal(afterLetter.value, FAMILY);
  const afterCluster = deleteBackward(afterLetter);
  assert.deepEqual(afterCluster, { value: "", cursor: 0, goalColumn: undefined });
});

test("deleteForward removes cluster after cursor and is a no-op at end", () => {
  const state = createLineBuffer(`a${FAMILY}`, 1);
  assert.deepEqual(deleteForward(state), { value: "a", cursor: 1, goalColumn: undefined });
  assert.equal(deleteForward(createLineBuffer("abc")).value, "abc");
  assert.equal(deleteForward(createLineBuffer("abc", 1)).value, "ac");
});

test("all operations are safe on empty buffer", () => {
  const empty = createLineBuffer("");
  const operations = [
    deleteBackward,
    deleteForward,
    deleteWordBackward,
    killToLineStart,
    killToLineEnd,
    moveLeft,
    moveRight,
    moveWordLeft,
    moveWordRight,
    moveToLineStart,
    moveToLineEnd,
    moveUp,
    moveDown,
  ];
  for (const operation of operations) {
    assert.deepEqual(operation(empty), empty, operation.name);
  }
});

test("deleteWordBackward matches readline semantics for ASCII", () => {
  assert.equal(deleteWordBackward(createLineBuffer("foo bar")).value, "foo ");
  assert.equal(deleteWordBackward(createLineBuffer("foo   bar")).value, "foo   ");
  assert.equal(deleteWordBackward(createLineBuffer("foo   ")).value, "");
  assert.equal(deleteWordBackward(createLineBuffer("foo, bar,")).value, "foo, ");
});

test("moveWordLeft and moveWordRight land on ASCII word boundaries", () => {
  const text = "hello  world, ok";
  let state = createLineBuffer(text);
  state = moveWordLeft(state);
  assert.equal(state.cursor, 14);
  state = moveWordLeft(state);
  assert.equal(state.cursor, 7);
  state = moveWordLeft(state);
  assert.equal(state.cursor, 0);
  state = moveWordRight(state);
  assert.equal(state.cursor, 5);
  state = moveWordRight(state);
  assert.equal(state.cursor, 12);
  state = moveWordRight(state);
  assert.equal(state.cursor, 16);
});

test("word movement crosses newlines", () => {
  assert.equal(moveWordLeft(createLineBuffer("ab\ncd", 3)).cursor, 0);
  assert.equal(moveWordRight(createLineBuffer("ab\ncd", 2)).cursor, 5);
});

test("moveWordLeft on CJK strictly decreases and stays on cluster boundaries", () => {
  const text = "中文分词测试很好";
  let state = createLineBuffer(text);
  const seen: number[] = [];
  while (state.cursor > 0) {
    const next = moveWordLeft(state);
    assert.ok(next.cursor < state.cursor);
    assert.equal(graphemeAt(text, next.cursor).length > 0 || next.cursor === text.length, true);
    seen.push(next.cursor);
    state = next;
  }
  assert.ok(seen.length >= 1);
});

test("moveToLineStart and moveToLineEnd stay within the current line", () => {
  const state = createLineBuffer("one\ntwo\nthree", 5);
  assert.equal(moveToLineStart(state).cursor, 4);
  assert.equal(moveToLineEnd(state).cursor, 7);
});

test("killToLineStart deletes only the current line segment", () => {
  const state = createLineBuffer("one\ntwo\nthree", 5);
  assert.deepEqual(killToLineStart(state), {
    value: "one\nwo\nthree",
    cursor: 4,
    goalColumn: undefined,
  });
  assert.equal(killToLineStart(createLineBuffer("one\ntwo", 4)).value, "one\ntwo");
});

test("killToLineEnd deletes to line end and swallows newline at line end", () => {
  const middle = createLineBuffer("one\ntwo\nthree", 5);
  assert.equal(killToLineEnd(middle).value, "one\nt\nthree");
  const atLineEnd = createLineBuffer("one\ntwo\nthree", 7);
  assert.equal(killToLineEnd(atLineEnd).value, "one\ntwothree");
  const atVeryEnd = createLineBuffer("one\ntwo");
  assert.equal(killToLineEnd(atVeryEnd).value, "one\ntwo");
});

test("moveUp and moveDown keep goal column across short lines", () => {
  const text = "abcdef\nab\nabcdef";
  let state = createLineBuffer(text, 14);
  state = moveUp(state);
  assert.equal(state.cursor, 9);
  assert.equal(state.goalColumn, 4);
  state = moveUp(state);
  assert.equal(state.cursor, 4);
  state = moveDown(state);
  assert.equal(state.cursor, 9);
  state = moveDown(state);
  assert.equal(state.cursor, 14);
});

test("vertical movement does not split wide characters", () => {
  const state = createLineBuffer("abcd\n汉字", 3);
  assert.equal(moveDown(state).cursor, 6);
});

test("vertical movement uses rendered width for emoji grapheme clusters", () => {
  const text = "👍🏽x\nabcd";
  const lower = moveDown(createLineBuffer(text, 4));
  assert.equal(lower.goalColumn, 2);
  assert.equal(lower.cursor, 8);
  assert.equal(moveUp(lower).cursor, 4);
});

test("moveUp on first line and moveDown on last line preserve state", () => {
  const state = createLineBuffer("abc", 1);
  assert.deepEqual(moveUp(state), state);
  assert.deepEqual(moveDown(state), state);
});

test("moveDown reaches empty trailing line", () => {
  const state = createLineBuffer("ab\n", 1);
  assert.equal(moveDown(state).cursor, 3);
});

test("visual movement follows hard-wrapped rows and preserves the goal column", () => {
  const text = "abcdefg";
  const upper = moveVisualUp(createLineBuffer(text), 4);
  assert.equal(upper.cursor, 3);
  assert.equal(upper.goalColumn, 3);
  const lower = moveVisualDown(upper, 4);
  assert.equal(lower.cursor, text.length);
  assert.equal(lower.goalColumn, 3);
});

test("visual movement never splits a wide character at the target column", () => {
  const upper = moveVisualUp(createLineBuffer("中文abc"), 4);
  assert.equal(upper.cursor, 1);
  assert.equal(upper.goalColumn, 3);
});

test("visual movement includes a wrapped cursor placeholder at an exact row boundary", () => {
  const upper = moveVisualUp(createLineBuffer("abcd"), 4);
  assert.equal(upper.cursor, 0);
  assert.equal(upper.goalColumn, 0);
});

test("horizontal movement and edits clear goal column", () => {
  const vertical = moveUp(createLineBuffer("abc\ndef", 5));
  assert.equal(vertical.goalColumn, 1);
  assert.equal(moveLeft(vertical).goalColumn, undefined);
  assert.equal(insertText(vertical, "x").goalColumn, undefined);
  assert.equal(deleteBackward(vertical).goalColumn, undefined);
});

test("graphemeAt returns full cluster or empty string", () => {
  assert.equal(graphemeAt(`a${FAMILY}b`, 1), FAMILY);
  assert.equal(graphemeAt("abc", 3), "");
  assert.equal(graphemeAt("汉", 0), "汉");
});
