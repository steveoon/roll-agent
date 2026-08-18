import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";
import {
  RAW_NUL_LABEL,
  describeLoneSurrogateRejection,
  describeRawNulRejection,
  findRawNul,
  rejectInvalidTextPayload,
} from "./control-chars.ts";

const ctrl = (code: number): string => String.fromCharCode(code);

test("findRawNul 报告首个 NUL 的行、列与下标", () => {
  const text = `line1${ctrl(0x0b)}tail\nline2${ctrl(0x00)}x${ctrl(0x00)}`;
  const finding = findRawNul(text);
  assert.ok(finding !== undefined);
  assert.equal(finding.line, 2);
  assert.equal(finding.column, 6);
  assert.equal(finding.index, 16);
});

test("findRawNul 放行普通文本、TAB、CRLF 与其它 C0/DEL 控制字符", () => {
  assert.equal(findRawNul("普通文本 with spaces\tand tabs\r\nand CRLF"), undefined);
  assert.equal(findRawNul(""), undefined);
  for (const code of [0x01, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f]) {
    assert.equal(findRawNul(`a${ctrl(code)}b`), undefined, `U+${code.toString(16)} 应放行`);
  }
});

test("RAW_NUL_LABEL 为 U+0000", () => {
  assert.equal(RAW_NUL_LABEL, "U+0000");
});

test("NUL 拒绝消息给出 JSON 双解码解释与两条自救路径", () => {
  const finding = findRawNul(`abc${ctrl(0x00)}`);
  assert.ok(finding !== undefined);
  const message = describeRawNulRejection("content", finding);
  assert.match(message, /U\+0000/u);
  assert.match(message, /第 1 行第 4 列/u);
  const single = String.fromCharCode(0x5c) + "u0000";
  const double = String.fromCharCode(0x5c, 0x5c) + "u0000";
  assert.ok(message.includes(single));
  assert.ok(message.includes(double));
  assert.ok(message.includes(`{"content": "${double}"}`));
  assert.match(message, /shell/u);
  assert.equal(findRawNul(message), undefined);
});

test("lone surrogate 拒绝消息不含原始代理项", () => {
  const message = describeLoneSurrogateRejection("content");
  assert.match(message, /lone surrogate/u);
  assert.equal(message.isWellFormed(), true);
});

test("rejectInvalidTextPayload 对 NUL 与 lone surrogate 返回 invalidInput，其余放行", () => {
  const nul = rejectInvalidTextPayload("content", `abc${ctrl(0x00)}def`);
  assert.ok(nul !== undefined);
  assert.equal(nul.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(nul.display), /U\+0000/u);
  const lone = rejectInvalidTextPayload("content", "abc\uD800def");
  assert.ok(lone !== undefined);
  assert.equal(lone.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(lone.display), /lone surrogate/u);
  assert.equal(rejectInvalidTextPayload("content", "clean text"), undefined);
  assert.equal(
    rejectInvalidTextPayload("content", `esc${ctrl(0x1b)}[0m ff${ctrl(0x0c)}`),
    undefined,
  );
  assert.equal(rejectInvalidTextPayload("content", "成对代理项 \u{1F600} ok"), undefined);
});
