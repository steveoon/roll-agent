import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey } from "./file-io.ts";
import { resolveFileToolsSettings } from "./settings.ts";
import { executeWriteFile } from "./write-file-tool.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

test("新文件写入成功并自动建父目录", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const settings = resolveFileToolsSettings({ workdir });
  const tracker = new FileStateTracker();
  const result = executeWriteFile(settings, tracker, {
    file_path: "sub/dir/new.txt",
    content: "第一行\n第二行",
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(join(workdir, "sub/dir/new.txt"), "utf8"), "第一行\n第二行");
  assert.match(String(result.display), /已写入/u);
  assert.match(String(result.display), / {4}1→第一行/u);
});

test("覆盖已存在但未读取过的文件被拒绝", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const path = join(workdir, "exists.txt");
  writeFileSync(path, "旧内容", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeWriteFile(settings, new FileStateTracker(), {
    file_path: "exists.txt",
    content: "新内容",
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /先用 roll__read_file/u);
  assert.equal(readFileSync(path, "utf8"), "旧内容");
});

test("读取过且未变化的文件允许覆盖", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const path = join(workdir, "exists.txt");
  writeFileSync(path, "旧内容", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const tracker = new FileStateTracker();
  tracker.recordKnownContent(canonicalFileKey(path), "旧内容");
  const result = executeWriteFile(settings, tracker, {
    file_path: "exists.txt",
    content: "新内容",
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(path, "utf8"), "新内容");
});

test("读取后被外部修改的文件拒绝覆盖", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const path = join(workdir, "exists.txt");
  writeFileSync(path, "v1", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const tracker = new FileStateTracker();
  tracker.recordKnownContent(canonicalFileKey(path), "v1");
  writeFileSync(path, "v2-外部修改", "utf8");
  const result = executeWriteFile(settings, tracker, { file_path: "exists.txt", content: "v3" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /已被修改/u);
  assert.equal(readFileSync(path, "utf8"), "v2-外部修改");
});

test("写入目标是目录时拒绝", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeWriteFile(settings, new FileStateTracker(), {
    file_path: ".",
    content: "x",
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.ok(existsSync(workdir));
});
