import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFileToolsSettings } from "./settings.ts";
import { executeListDir } from "./list-dir-tool.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

test("目录优先排序且文件附带大小", () => {
  const workdir = mkdtempSync(join(tmpdir(), "list-dir-test-"));
  mkdirSync(join(workdir, "zdir"));
  writeFileSync(join(workdir, "a.txt"), "hello", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeListDir(settings, {});
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.ok(text.indexOf("zdir/") < text.indexOf("a.txt"));
  assert.match(text, /a\.txt（5 字节）/u);
});

test("不存在的目录返回 invalid_input", () => {
  const workdir = mkdtempSync(join(tmpdir(), "list-dir-test-"));
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeListDir(settings, { path: "nope" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
});

test("超过 300 项时截断并提示", () => {
  const workdir = mkdtempSync(join(tmpdir(), "list-dir-test-"));
  for (let index = 0; index < 305; index += 1) {
    writeFileSync(join(workdir, `f${String(index).padStart(3, "0")}.txt`), "", "utf8");
  }
  const text = String(executeListDir(resolveFileToolsSettings({ workdir }), {}).display);
  assert.match(text, /仅显示前 300 项（共 305 项）/u);
});
