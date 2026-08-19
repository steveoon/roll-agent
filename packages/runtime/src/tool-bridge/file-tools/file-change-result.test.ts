import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFileChange, fileChangeToolResult } from "./file-change-result.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

test("describeFileChange 使用工作目录相对路径并产出 unified", () => {
  const workdir = mkdtempSync(join(tmpdir(), "file-change-"));
  const diff = describeFileChange({
    workdir,
    inputPath: join(workdir, "src", "a.ts"),
    change: "modify",
    before: "a\n",
    after: "b\n",
  });
  assert.equal(diff?.path, join("src", "a.ts"));
  assert.equal(diff?.added, 1);
  assert.equal(diff?.removed, 1);
  assert.match(
    diff?.unified ?? "",
    /^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@ -1,1 \+1,1 @@\n-a\n\+b\n$/u,
  );
});

test("fileChangeToolResult 的 display 为 {text, diff}，model 与 raw 保持文本快照", () => {
  const diff = describeFileChange({
    workdir: tmpdir(),
    inputPath: "x.txt",
    change: "create",
    before: "",
    after: "hi\n",
  });
  assert.ok(diff);
  const result = fileChangeToolResult("已写入 x.txt", diff);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.deepEqual(result.display, { text: "已写入 x.txt", diff });
  assert.deepEqual(result.model, { type: "text", value: "已写入 x.txt" });
  const plain = fileChangeToolResult("已写入 x.txt", undefined);
  assert.equal(plain.display, "已写入 x.txt");
  assert.deepEqual(plain.model, { type: "text", value: "已写入 x.txt" });
});
