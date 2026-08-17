import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";
import {
  describeRawControlCharRejection,
  findRawControlChar,
  formatControlCharCode,
  isRawControlCode,
  rejectTextWithRawControlChars,
} from "./control-chars.ts";

const ctrl = (code: number): string => String.fromCharCode(code);

test("isRawControlCode 覆盖 C0（除 TAB/LF/CR）与 DEL", () => {
  assert.equal(isRawControlCode(0x00), true);
  assert.equal(isRawControlCode(0x08), true);
  assert.equal(isRawControlCode(0x09), false);
  assert.equal(isRawControlCode(0x0a), false);
  assert.equal(isRawControlCode(0x0b), true);
  assert.equal(isRawControlCode(0x0c), true);
  assert.equal(isRawControlCode(0x0d), false);
  assert.equal(isRawControlCode(0x1f), true);
  assert.equal(isRawControlCode(0x20), false);
  assert.equal(isRawControlCode(0x7e), false);
  assert.equal(isRawControlCode(0x7f), true);
  assert.equal(isRawControlCode(0x80), false);
  assert.equal(isRawControlCode(0xfeff), false);
});

test("findRawControlChar 报告首个违规字符的行、列与码点", () => {
  const text = `line1${ctrl(0x00)}tail\nline2${ctrl(0x0b)}`;
  const finding = findRawControlChar(text);
  assert.ok(finding !== undefined);
  assert.equal(finding.line, 1);
  assert.equal(finding.column, 6);
  assert.equal(finding.code, 0x00);
  assert.equal(finding.index, 5);
});

test("findRawControlChar 放行普通文本、TAB 与 CRLF", () => {
  assert.equal(findRawControlChar("普通文本 with spaces\tand tabs\r\nand CRLF"), undefined);
  assert.equal(findRawControlChar(""), undefined);
});

test("formatControlCharCode 输出 4 位大写十六进制", () => {
  assert.equal(formatControlCharCode(0x00), "U+0000");
  assert.equal(formatControlCharCode(0x0b), "U+000B");
  assert.equal(formatControlCharCode(0x7f), "U+007F");
});

test("拒绝消息给出 JSON 双解码解释与两条自救路径", () => {
  const finding = findRawControlChar(`abc${ctrl(0x00)}`);
  assert.ok(finding !== undefined);
  const message = describeRawControlCharRejection("content", finding);
  assert.match(message, /U\+0000/u);
  // The single-escape example must be the 6 ASCII characters, not a raw NUL.
  const single = String.fromCharCode(0x5c) + "u0000";
  const double = String.fromCharCode(0x5c, 0x5c) + "u0000";
  assert.ok(message.includes(single));
  assert.ok(message.includes(double));
  assert.match(message, /shell/u);
});

test("rejectTextWithRawControlChars 命中返回 invalidInput，未命中返回 undefined", () => {
  const rejected = rejectTextWithRawControlChars("content", `abc${ctrl(0x1b)}def`);
  assert.ok(rejected !== undefined);
  assert.equal(rejected.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.equal(rejectTextWithRawControlChars("content", "clean text"), undefined);
});
