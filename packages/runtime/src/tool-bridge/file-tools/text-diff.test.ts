import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch } from "diff";
import {
  FILE_CHANGE_DIFF_LIMITS,
  buildFileChangeDiff,
  buildFileChangePreview,
} from "./text-diff.ts";

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

test("buildFileChangeDiff 只给统计时仍按真实编辑脚本计数（多处改动不会被前后缀 trim 合并）", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i)}`);
  const changed = [...lines];
  changed[10] = "LINE 10";
  changed[150] = "LINE 150";
  const diff = buildFileChangeDiff({
    path: "f",
    change: "modify",
    before: lines.join("\n"),
    after: changed.join("\n"),
    limits: { maxInputBytes: 10 },
  });
  assert.equal(diff.unified, undefined);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
  assert.equal(diff.hunks, 2);
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
  assert.equal(diff.truncated, true);
});

test("buildFileChangeDiff 默认上限与常量一致且 unified 长度不超过生产上限", () => {
  assert.equal(FILE_CHANGE_DIFF_LIMITS.maxUnifiedChars, 12_000);
  const before = Array.from({ length: 2_000 }, (_, i) => `row ${String(i)}`).join("\n");
  const after = Array.from({ length: 2_000 }, (_, i) => `ROW ${String(i)}`).join("\n");
  const diff = buildFileChangeDiff({ path: "f", change: "modify", before, after });
  assert.ok((diff.unified?.length ?? 0) <= 12_000);
  assert.equal(diff.truncated, true);
});

test("超过 1000 编辑距离的散落修改仍保留 1001 处实际替换，完整预览可重放", () => {
  const before = Array.from(
    { length: 1001 },
    (_, i) => `item ${i}: timeout: 30\nanchor ${i}\n`,
  ).join("");
  const after = before.replaceAll("timeout: 30", "timeout: 5");
  const { diff, fullDiff } = buildFileChangePreview({
    path: "generated.txt",
    change: "modify",
    before,
    after,
    // Exercise the exact algorithm independently of CPU contention in the full suite.
    // The production deadline's explicit before/after fallback is tested separately below.
    limits: { timeoutMs: 10_000 },
  });
  assert.equal(diff.added, 1001);
  assert.equal(diff.removed, 1001);
  assert.equal(diff.truncated, true);
  assert.ok(fullDiff.length > 12_000);
  assert.match(fullDiff, /item 1000: timeout: 5/u);
  assert.equal(applyPatch(before, fullDiff), after);
});

test("大文件省略 inline 正文但完整预览仍可重放；末行与 CRLF 保留", () => {
  const before = `${"padding\r\n".repeat(80_000)}tail`;
  const after = `${before}\r\n`;
  const { diff, fullDiff } = buildFileChangePreview({
    path: "large.txt",
    change: "modify",
    before,
    after,
  });
  assert.equal(diff.unified, undefined);
  assert.equal(diff.truncated, true);
  assert.equal(applyPatch(before, fullDiff), after);
});

test("diff 预算耗尽提供明确标记的完整全文对照", () => {
  const before = "old\nlast old\n";
  const after = "new\nlast new\n";
  const { diff, fullDiff } = buildFileChangePreview({
    path: "f",
    change: "modify",
    before,
    after,
    limits: { timeoutMs: -1 },
  });
  assert.equal(diff.coarse, true);
  assert.equal(diff.unified, undefined);
  assert.match(fullDiff, /非增删行统计/u);
  assert.ok(fullDiff.includes(before));
  assert.ok(fullDiff.includes(after));
});

test("全文降级明确保留末行没有换行的信息", () => {
  const { fullDiff } = buildFileChangePreview({
    path: "f",
    change: "modify",
    before: "old without newline",
    after: "new with newline\n",
    limits: { timeoutMs: -1 },
  });
  assert.match(fullDiff, /old without newline\n\\ No newline at end of file\n\+\+\+/u);
  assert.equal(fullDiff.split("\\ No newline at end of file").length, 2);
  assert.ok(fullDiff.endsWith("new with newline\n"));
});
