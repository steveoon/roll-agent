import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILE_CHANGE_DIFF_LIMITS,
  buildFileChangeDiff,
  diffLines,
  splitLinesKeepingNewline,
  type LineOp,
} from "./text-diff.ts";

function replay(
  before: readonly string[],
  after: readonly string[],
  ops: readonly LineOp[],
): string[] {
  const out: string[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const op of ops) {
    if (op.kind === "equal") {
      assert.equal(op.oldIndex, oldIndex);
      assert.equal(op.newIndex, newIndex);
      assert.equal(before[oldIndex], after[newIndex]);
      out.push(after[newIndex] ?? "");
      oldIndex += 1;
      newIndex += 1;
    } else if (op.kind === "delete") {
      assert.equal(op.oldIndex, oldIndex);
      oldIndex += 1;
    } else {
      assert.equal(op.newIndex, newIndex);
      out.push(after[newIndex] ?? "");
      newIndex += 1;
    }
  }
  assert.equal(oldIndex, before.length);
  assert.equal(newIndex, after.length);
  return out;
}

test("splitLinesKeepingNewline 保留行尾换行并区分末行是否有换行", () => {
  assert.deepEqual(splitLinesKeepingNewline(""), []);
  assert.deepEqual(splitLinesKeepingNewline("a"), ["a"]);
  assert.deepEqual(splitLinesKeepingNewline("a\n"), ["a\n"]);
  assert.deepEqual(splitLinesKeepingNewline("a\nb"), ["a\n", "b"]);
  assert.deepEqual(splitLinesKeepingNewline("a\r\nb\r\n"), ["a\r\n", "b\r\n"]);
});

test("diffLines 对相同输入只产出 equal，对空输入产出纯 insert / delete", () => {
  assert.deepEqual(diffLines(["a", "b"], ["a", "b"], 100), [
    { kind: "equal", oldIndex: 0, newIndex: 0 },
    { kind: "equal", oldIndex: 1, newIndex: 1 },
  ]);
  assert.deepEqual(diffLines([], ["x", "y"], 100), [
    { kind: "insert", newIndex: 0 },
    { kind: "insert", newIndex: 1 },
  ]);
  assert.deepEqual(diffLines(["x"], [], 100), [{ kind: "delete", oldIndex: 0 }]);
});

test("diffLines 产出最小编辑脚本并可重放得到 after", () => {
  const before = ["a", "b", "c", "d", "e"];
  const after = ["a", "x", "c", "e", "f"];
  const ops = diffLines(before, after, 100);
  assert.deepEqual(replay(before, after, ops), after);
  const changes = ops.filter((op) => op.kind !== "equal").length;
  assert.equal(changes, 4);
});

test("diffLines 在随机输入上重放正确（性质测试）", () => {
  let seed = 20260819;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = ["a", "b", "c", "d"];
  for (let round = 0; round < 300; round += 1) {
    const before = Array.from({ length: rand(12) }, () => alphabet[rand(alphabet.length)] ?? "a");
    const after = Array.from({ length: rand(12) }, () => alphabet[rand(alphabet.length)] ?? "a");
    const ops = diffLines(before, after, 100);
    assert.deepEqual(replay(before, after, ops), after);
  }
});

test("diffLines 超过编辑距离上限时退化为前后缀外整段替换，仍可重放", () => {
  const before = ["same", "1", "2", "3", "4", "tail"];
  const after = ["same", "a", "b", "c", "d", "e", "tail"];
  const ops = diffLines(before, after, 1);
  assert.deepEqual(replay(before, after, ops), after);
  assert.deepEqual(ops[0], { kind: "equal", oldIndex: 0, newIndex: 0 });
  assert.deepEqual(ops.at(-1), { kind: "equal", oldIndex: 5, newIndex: 6 });
  assert.equal(ops.filter((op) => op.kind === "delete").length, 4);
  assert.equal(ops.filter((op) => op.kind === "insert").length, 5);
});

test("buildFileChangeDiff 生成带文件头、hunk 头与 3 行上下文的 unified", () => {
  const before = Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`).join("\n") + "\n";
  const after = before.replace("line 6", "line six");
  const diff = buildFileChangeDiff({ path: "src/a.ts", change: "modify", before, after });
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks, 1);
  assert.equal(diff.truncated, false);
  assert.equal(
    diff.unified,
    [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,7 +3,7 @@",
      " line 3",
      " line 4",
      " line 5",
      "-line 6",
      "+line six",
      " line 7",
      " line 8",
      " line 9",
      "",
    ].join("\n"),
  );
});

test("buildFileChangeDiff 相距超过 6 行的改动拆成两个 hunk，≤ 6 行合并为一个", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `l${String(i + 1)}`);
  const far = [...lines];
  far[1] = "L2";
  far[20] = "L21";
  const farDiff = buildFileChangeDiff({
    path: "f",
    change: "modify",
    before: lines.join("\n"),
    after: far.join("\n"),
  });
  assert.equal(farDiff.hunks, 2);
  assert.match(farDiff.unified ?? "", /^@@ -1,5 \+1,5 @@$/mu);
  const near = [...lines];
  near[9] = "L10";
  near[16] = "L17";
  const nearDiff = buildFileChangeDiff({
    path: "f",
    change: "modify",
    before: lines.join("\n"),
    after: near.join("\n"),
  });
  assert.equal(nearDiff.hunks, 1);
});

test("buildFileChangeDiff 新建文件使用 /dev/null 头且全部为新增", () => {
  const diff = buildFileChangeDiff({
    path: "new.txt",
    change: "create",
    before: "",
    after: "a\nb\n",
  });
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
  assert.equal(diff.unified, "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
});

test("buildFileChangeDiff 末行无换行时输出标准标记", () => {
  const diff = buildFileChangeDiff({
    path: "f",
    change: "modify",
    before: "a\nb",
    after: "a\nb\n",
  });
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(
    diff.unified,
    "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n",
  );
});

test("buildFileChangeDiff 按字符上限在行边界截断并标记 truncated，统计不受影响", () => {
  const before = Array.from({ length: 400 }, (_, i) => `row ${String(i)}`).join("\n");
  const after = Array.from({ length: 400 }, (_, i) => `ROW ${String(i)}`).join("\n");
  const diff = buildFileChangeDiff({
    path: "f",
    change: "modify",
    before,
    after,
    limits: { maxUnifiedChars: 200 },
  });
  assert.equal(diff.added, 400);
  assert.equal(diff.removed, 400);
  assert.equal(diff.truncated, true);
  assert.ok((diff.unified?.length ?? 0) <= 200);
  assert.ok(diff.unified?.endsWith("\n"));
});

test("buildFileChangeDiff 输入超过字节上限时只给统计不给正文", () => {
  const before = "keep\n" + "x".repeat(600) + "\nkeep2\n";
  const after = "keep\n" + "y".repeat(600) + "\nkeep2\n";
  const diff = buildFileChangeDiff({
    path: "big.txt",
    change: "modify",
    before,
    after,
    limits: { maxInputBytes: 1_000 },
  });
  assert.equal(diff.unified, undefined);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks, 1);
  assert.equal(diff.truncated, false);
});

test("buildFileChangeDiff 默认上限与常量一致且 unified 长度不超过生产上限", () => {
  assert.equal(FILE_CHANGE_DIFF_LIMITS.maxUnifiedChars, 12_000);
  const before = Array.from({ length: 2_000 }, (_, i) => `row ${String(i)}`).join("\n");
  const after = Array.from({ length: 2_000 }, (_, i) => `ROW ${String(i)}`).join("\n");
  const diff = buildFileChangeDiff({ path: "f", change: "modify", before, after });
  assert.ok((diff.unified?.length ?? 0) <= 12_000);
  assert.equal(diff.truncated, true);
});
