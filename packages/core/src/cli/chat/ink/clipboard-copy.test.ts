import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOsc52, lastRoundCopyText, wrapTmuxPassthrough } from "./clipboard-copy.ts";
import type { HistoryItem } from "./state.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function user(text: string): HistoryItem {
  return { kind: "user", id: `u-${text}`, text };
}

function assistant(text: string): HistoryItem {
  return { kind: "assistant", id: `a-${text}`, text };
}

test("lastRoundCopyText 取最后一条用户消息与其后的助手回复", () => {
  const history: HistoryItem[] = [
    user("第一问"),
    assistant("第一答"),
    user("第二问"),
    assistant("第二答"),
  ];
  assert.equal(lastRoundCopyText(history), "用户: 第二问\n\n助手: 第二答");
});

test("lastRoundCopyText 合并同一轮的多段助手输出并跳过非消息条目", () => {
  const history: HistoryItem[] = [
    user("问"),
    assistant("上半"),
    { kind: "notice", id: "n1", text: "忽略我" },
    assistant("下半"),
  ];
  assert.equal(lastRoundCopyText(history), "用户: 问\n\n助手: 上半\n\n下半");
});

test("lastRoundCopyText 在助手尚未回复时只复制用户消息", () => {
  assert.equal(lastRoundCopyText([user("刚发出")]), "用户: 刚发出");
});

test("lastRoundCopyText 无用户消息时返回 undefined", () => {
  assert.equal(lastRoundCopyText([]), undefined);
  assert.equal(lastRoundCopyText([{ kind: "notice", id: "n", text: "x" }]), undefined);
});

test("buildOsc52 生成 base64 负载的 OSC 52 序列", () => {
  const expected = `${ESC}]52;c;${Buffer.from("hi", "utf8").toString("base64")}${BEL}`;
  assert.equal(buildOsc52("hi"), expected);
});

test("wrapTmuxPassthrough 转义内层 ESC 并加 DCS 信封", () => {
  const inner = `${ESC}]52;c;aGk=${BEL}`;
  const wrapped = wrapTmuxPassthrough(inner);
  assert.ok(wrapped.startsWith(`${ESC}Ptmux;`));
  assert.ok(wrapped.endsWith(`${ESC}${String.fromCharCode(92)}`));
  assert.ok(wrapped.includes(`${ESC}${ESC}]52;c;`));
});
