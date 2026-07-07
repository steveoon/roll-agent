import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeScript } from "./tokenize.ts";

function words(script: string): string[] {
  const lexemes = tokenizeScript(script);
  assert.notEqual(lexemes, null);
  return (lexemes ?? []).filter((l) => l.kind === "word").map((l) => l.value);
}

test("引号包裹的命令名当作单个 word（'git status' 不被拆）", () => {
  assert.deepEqual(words("'git status'"), ["git status"]);
  assert.deepEqual(words('"git status"'), ["git status"]);
});

test("引号与裸字符拼接为一个 word", () => {
  assert.deepEqual(words('grep -e "a b" file'), ["grep", "-e", "a b", "file"]);
});

test("&& 是操作符，单 & 判非法返回 null", () => {
  const compound = tokenizeScript("ls && pwd");
  assert.deepEqual(compound, [
    { kind: "word", value: "ls" },
    { kind: "op", value: "&&" },
    { kind: "word", value: "pwd" },
  ]);
  assert.equal(tokenizeScript("ls & pwd"), null);
});

test("| ; || 分隔为操作符", () => {
  assert.deepEqual(tokenizeScript("cat a | grep b"), [
    { kind: "word", value: "cat" },
    { kind: "word", value: "a" },
    { kind: "op", value: "|" },
    { kind: "word", value: "grep" },
    { kind: "word", value: "b" },
  ]);
  const semi = tokenizeScript("ls ; pwd");
  assert.equal(
    semi?.some((l) => l.kind === "op" && l.value === ";"),
    true,
  );
});

test("未闭合引号返回 null", () => {
  assert.equal(tokenizeScript("echo 'unterminated"), null);
});

test("换行是命令分隔符（等价 ;），不是普通空白", () => {
  assert.deepEqual(tokenizeScript("ls\npwd"), [
    { kind: "word", value: "ls" },
    { kind: "op", value: ";" },
    { kind: "word", value: "pwd" },
  ]);
  assert.deepEqual(tokenizeScript("ls\r\npwd"), [
    { kind: "word", value: "ls" },
    { kind: "op", value: ";" },
    { kind: "word", value: "pwd" },
  ]);
});

test("操作符后的换行是续行，不产生分隔符", () => {
  assert.deepEqual(tokenizeScript("ls &&\npwd"), [
    { kind: "word", value: "ls" },
    { kind: "op", value: "&&" },
    { kind: "word", value: "pwd" },
  ]);
});

test("引号内换行属于 word 本身", () => {
  assert.deepEqual(tokenizeScript('echo "a\nb"'), [
    { kind: "word", value: "echo" },
    { kind: "word", value: "a\nb" },
  ]);
});
