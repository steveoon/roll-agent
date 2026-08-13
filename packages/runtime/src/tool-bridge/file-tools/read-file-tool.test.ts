import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_FRESHNESS, FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey } from "./file-io.ts";
import { resolveFileToolsSettings } from "./settings.ts";
import { executeReadFile } from "./read-file-tool.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

function fixture(): { workdir: string; tracker: FileStateTracker } {
  return {
    workdir: mkdtempSync(join(tmpdir(), "read-tool-test-")),
    tracker: new FileStateTracker(),
  };
}

test("读取返回头部行数与带行号正文，并记录 tracker", () => {
  const { workdir, tracker } = fixture();
  const path = join(workdir, "a.txt");
  writeFileSync(path, "第一行\n第二行\n第三行", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "a.txt" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.match(text, /共 3 行/u);
  assert.match(text, / {4}1→第一行/u);
  assert.match(text, / {4}3→第三行/u);
  assert.equal(
    tracker.checkFreshness(canonicalFileKey(path), "第一行\n第二行\n第三行"),
    FILE_FRESHNESS.fresh,
  );
});

test("offset 与 limit 控制窗口并提示继续位置", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "b.txt"), ["l1", "l2", "l3", "l4", "l5"].join("\n"), "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "b.txt", offset: 2, limit: 2 });
  const text = String(result.display);
  assert.match(text, / {4}2→l2/u);
  assert.match(text, / {4}3→l3/u);
  assert.doesNotMatch(text, / {4}4→l4/u);
  assert.match(text, /从第 4 行继续/u);
});

test("不存在的文件返回 invalid_input", () => {
  const { workdir, tracker } = fixture();
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "missing.txt" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
});

test("offset 超出行数返回 invalid_input", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "c.txt"), "only", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "c.txt", offset: 9 });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
});

test("超长单行被截断标注", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "d.txt"), "x".repeat(1500), "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const text = String(executeReadFile(settings, tracker, { path: "d.txt" }).display);
  assert.match(text, /\[行截断\]/u);
});
