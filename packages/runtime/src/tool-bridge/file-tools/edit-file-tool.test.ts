import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey } from "./file-io.ts";
import { resolveFileToolsSettings, type ResolvedFileToolsSettings } from "./settings.ts";
import { executeEditFile } from "./edit-file-tool.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

interface Fixture {
  readonly workdir: string;
  readonly path: string;
  readonly settings: ResolvedFileToolsSettings;
  readonly tracker: FileStateTracker;
}

function fixture(content: string): Fixture {
  const workdir = mkdtempSync(join(tmpdir(), "edit-tool-test-"));
  const path = join(workdir, "target.txt");
  writeFileSync(path, content, "utf8");
  return {
    workdir,
    path,
    settings: resolveFileToolsSettings({ workdir }),
    tracker: new FileStateTracker(),
  };
}

function markRead(f: Fixture): void {
  f.tracker.recordKnownContent(canonicalFileKey(f.path), readFileSync(f.path, "utf8"));
}

test("未读取过的文件拒绝编辑", () => {
  const f = fixture("内容");
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "内容", new_string: "新内容" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /先用 roll__read_file/u);
  assert.equal(readFileSync(f.path, "utf8"), "内容");
});

test("外部修改后拒绝并引导重读", () => {
  const f = fixture("v1");
  markRead(f);
  writeFileSync(f.path, "v2-外部修改", "utf8");
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "v1", new_string: "v3" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /已被修改/u);
  assert.match(String(result.display), /重新 roll__read_file/u);
});

test("唯一命中成功改写并返回编辑点快照", () => {
  const f = fixture("第一行\n目标行\n第三行");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "目标行", new_string: "修改后的行" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "第一行\n修改后的行\n第三行");
  const text = String(result.display);
  assert.match(text, /已完成 1 处修改/u);
  assert.match(text, / {4}2→修改后的行/u);
});

test("编辑成功后无需重读即可继续编辑", () => {
  const f = fixture("a\nb");
  markRead(f);
  const first = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "a", new_string: "A" }],
  });
  assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const second = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "b", new_string: "B" }],
  });
  assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "A\nB");
});

test("归一化命中只替换目标段且保留文件其余字节", () => {
  const f = fixture("保留“原样”前缀\n标题：“花卷”\n保留“原样”后缀");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: '标题:"花卷"', new_string: "标题：《花卷》" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "保留“原样”前缀\n标题：《花卷》\n保留“原样”后缀");
});

test("多处命中失败并列出位置", () => {
  const f = fixture("x=1\ny\nx=1");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "x=1", new_string: "x=2" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /出现 2 次/u);
  assert.equal(readFileSync(f.path, "utf8"), "x=1\ny\nx=1");
});

test("replace_all 替换全部精确命中", () => {
  const f = fixture("x=1\ny\nx=1");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "x=1", new_string: "x=2", replace_all: true }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "x=2\ny\nx=2");
});

test("批量编辑原子性：第二条失败则第一条不落盘", () => {
  const f = fixture("alpha\nbeta");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [
      { old_string: "alpha", new_string: "ALPHA" },
      { old_string: "不存在的内容", new_string: "x" },
    ],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /第 2 条编辑（共 2 条）失败/u);
  assert.match(String(result.display), /未写入任何修改/u);
  assert.equal(readFileSync(f.path, "utf8"), "alpha\nbeta");
});

test("批量编辑顺序应用：后条可匹配前条结果", () => {
  const f = fixture("v1");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [
      { old_string: "v1", new_string: "v2" },
      { old_string: "v2", new_string: "v3" },
    ],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "v3");
});

test("CRLF 文件回写保持 CRLF", () => {
  const f = fixture("first\r\nsecond\r\n");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "first\nsecond", new_string: "first\nchanged" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "first\r\nchanged\r\n");
});

test("old_string 与 new_string 相同返回 invalid_input", () => {
  const f = fixture("same");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "same", new_string: "same" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
});

test("单条编辑无匹配的失败提示引导改用 write_file 整文件重写", () => {
  const f = fixture("alpha\nbeta");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "不存在的内容", new_string: "x" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /roll__write_file 整文件重写/u);
});

test("replace_all 无匹配的失败提示引导改用 write_file 整文件重写", () => {
  const f = fixture("alpha\nbeta");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "不存在的内容", new_string: "x", replace_all: true }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /roll__write_file 整文件重写/u);
});

test("BOM 文件编辑后 BOM 保留", () => {
  const f = fixture("\uFEFF内容");
  f.tracker.recordKnownContent(canonicalFileKey(f.path), "内容");
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "内容", new_string: "新内容" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "\uFEFF新内容");
});
