import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey, loadTextFile } from "./file-io.ts";
import { resolveFileToolsSettings, type ResolvedFileToolsSettings } from "./settings.ts";
import { buildEditFileTool, executeEditFile } from "./edit-file-tool.ts";
import { buildWriteFileTool } from "./write-file-tool.ts";
import { planEdits } from "./edit-plan.ts";
import { describeFileChange } from "./file-change-result.ts";
import { ToolExecutionCoordinator } from "../tool-execution-coordinator.ts";
import type { FileChangeDiff } from "@roll-agent/protocol";
import type { ApprovalRequest } from "../build-tools.ts";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { SessionApprovalMemory } from "../../approval/approval-memory.ts";
import type { ApprovalDecision } from "../../approval/approval-gate.ts";
import { TOOL_OUTCOME_KINDS, type NormalizedToolResult } from "../normalize-result.ts";

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

const ctrl = (code: number): string => String.fromCharCode(code);

test("old_string 含原始 NUL 被拒绝且不写入", () => {
  const f = fixture("abc");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: `a${ctrl(0x00)}b`, new_string: "x" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(result.display), /old_string/u);
  assert.match(String(result.display), /U\+0000/u);
  assert.equal(readFileSync(f.path, "utf8"), "abc");
});

test("new_string 含原始 NUL 被拒绝且不写入，消息指明编辑序号", () => {
  const f = fixture("abc");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [
      { old_string: "abc", new_string: "abd" },
      { old_string: "abd", new_string: `x${ctrl(0x00)}y` },
    ],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(result.display), /第 2 条编辑（共 2 条）的 new_string/u);
  assert.match(String(result.display), /U\+0000/u);
  assert.equal(readFileSync(f.path, "utf8"), "abc");
});

test("new_string 含 ESC/FF/VT/DEL 等非 NUL 控制字符可写入并可回读", () => {
  const f = fixture("plain line\n");
  markRead(f);
  const ansi = `${ctrl(0x1b)}[32mgreen${ctrl(0x1b)}[0m${ctrl(0x0c)}${ctrl(0x0b)}${ctrl(0x7f)}`;
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "plain", new_string: ansi }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), `${ansi} line\n`);
  const loaded = loadTextFile(f.path, { maxFileBytes: 1024 });
  assert.ok(loaded.ok);
  assert.equal(loaded.content, `${ansi} line\n`);
  const again = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: ansi, new_string: "plain" }],
  });
  assert.equal(again.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "plain line\n");
});

test("old_string/new_string 含 lone surrogate 被拒绝且不写入", () => {
  const f = fixture("abc");
  markRead(f);
  const inNew = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "abc", new_string: "ab\uDC00" }],
  });
  assert.equal(inNew.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(inNew.display), /new_string.*lone surrogate/u);
  const inOld = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "a\uD83D", new_string: "x" }],
  });
  assert.equal(inOld.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(inOld.display), /old_string.*lone surrogate/u);
  assert.equal(readFileSync(f.path, "utf8"), "abc");
});

test("old_string/new_string 含转义序列文本（6 个 ASCII 字符）正常编辑", () => {
  const singleEscape = String.fromCharCode(0x5c) + "u0000";
  const f = fixture(`const a = "${singleEscape}";`);
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: `"${singleEscape}"`, new_string: `"${singleEscape}${singleEscape}"` }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
});

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
  const display = result.display as { text: string; diff: unknown };
  assert.match(display.text, /已完成 1 处修改/u);
  assert.match(display.text, / {4}2→修改后的行/u);
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

test("CRLF 文件上只改换行符的编辑被拒绝且不写入", () => {
  const f = fixture("first\r\nsecond\r\n");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "first\nsecond", new_string: "first\r\nsecond" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(result.display), /只改换行符不会产生变化/u);
  assert.equal(readFileSync(f.path, "utf8"), "first\r\nsecond\r\n");
});

test("多条编辑互相抵消导致内容不变时拒绝并说明", () => {
  const f = fixture("alpha beta\n");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [
      { old_string: "alpha", new_string: "gamma" },
      { old_string: "gamma", new_string: "alpha" },
    ],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(result.display), /与原文件完全相同/u);
  assert.equal(readFileSync(f.path, "utf8"), "alpha beta\n");
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

function executeOptions(): ToolExecutionOptions<unknown> {
  return { toolCallId: "call-1", messages: [], context: undefined };
}

test("含 NUL 的编辑在弹窗前被拒绝，不产生审批请求", async () => {
  const f = fixture("abc");
  markRead(f);
  const approvals: ApprovalRequest[] = [];
  const tools = buildEditFileTool(f.settings, f.tracker, new ToolRegistry(), {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve({ approved: true, scope: "session" });
    },
    approvalMemory: new SessionApprovalMemory(),
  });
  const editTool = tools.roll__edit_file;
  assert.ok(editTool?.execute !== undefined);
  const result = (await editTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "abc", new_string: `x${ctrl(0x00)}y` }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(result.display), /U\+0000/u);
  assert.equal(approvals.length, 0);
  assert.equal(readFileSync(f.path, "utf8"), "abc");
});

function buildEditFixture(
  f: Fixture,
  approvals: ApprovalRequest[],
  decision: ApprovalDecision = { approved: true },
) {
  return buildEditFileTool(f.settings, f.tracker, new ToolRegistry(), {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve(decision);
    },
    approvalMemory: new SessionApprovalMemory(),
  });
}

test("edit_file 审批请求携带 dry-run diff，批准后写入且结果 display 含同一 diff、model 仍为快照文本", async () => {
  const f = fixture("line1\nline2\nline3\n");
  markRead(f);
  const approvals: ApprovalRequest[] = [];
  const editTool = buildEditFixture(f, approvals).roll__edit_file;
  assert.ok(editTool?.execute !== undefined);
  const result = (await editTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "line2", new_string: "LINE2" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.diff?.path, "target.txt");
  assert.equal(approvals[0]?.diff?.added, 1);
  assert.equal(approvals[0]?.diff?.removed, 1);
  assert.match(approvals[0]?.diff?.unified ?? "", /-line2\n\+LINE2\n/u);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "line1\nLINE2\nline3\n");
  const display = result.display as { text: string; diff: unknown };
  assert.match(display.text, /已完成 1 处修改并写入/u);
  assert.deepEqual(display.diff, approvals[0]?.diff);
  assert.deepEqual(result.model, { type: "text", value: display.text });
});

test("edit_file 拒绝审批后文件未写入", async () => {
  const f = fixture("keep\n");
  markRead(f);
  const approvals: ApprovalRequest[] = [];
  const editTool = buildEditFixture(f, approvals, { approved: false }).roll__edit_file;
  assert.ok(editTool?.execute !== undefined);
  const result = (await editTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "keep", new_string: "gone" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(approvals.length, 1);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.userRejected);
  assert.equal(readFileSync(f.path, "utf8"), "keep\n");
});

test("edit_file 内容相关的失败（未读取 / 不匹配）不在审批前短路：仍走审批但不带 diff，执行阶段照旧失败", async () => {
  const unread = fixture("abc\n");
  const approvals: ApprovalRequest[] = [];
  const unreadTool = buildEditFixture(unread, approvals).roll__edit_file;
  assert.ok(unreadTool?.execute !== undefined);
  const unreadResult = (await unreadTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "abc", new_string: "x" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(unreadResult.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(unreadResult.display), /尚未读取过/u);
  assert.equal(approvals.length, 1);
  assert.equal(Object.hasOwn(approvals[0] ?? {}, "diff"), false);

  const mismatch = fixture("abc\n");
  markRead(mismatch);
  const mismatchTool = buildEditFixture(mismatch, approvals).roll__edit_file;
  assert.ok(mismatchTool?.execute !== undefined);
  const mismatchResult = (await mismatchTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "zzz", new_string: "x" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(mismatchResult.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.equal(approvals.length, 2);
  assert.equal(Object.hasOwn(approvals[1] ?? {}, "diff"), false);
  assert.equal(readFileSync(mismatch.path, "utf8"), "abc\n");
});

test("edit_file 输入本身无效（old_string 与 new_string 相同）在审批前直接失败", async () => {
  const f = fixture("abc\n");
  markRead(f);
  const approvals: ApprovalRequest[] = [];
  const editTool = buildEditFixture(f, approvals).roll__edit_file;
  assert.ok(editTool?.execute !== undefined);
  const result = (await editTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "abc", new_string: "abc" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.equal(approvals.length, 0);
});

test("edit_file 工作目录外路径在策略门之前不触碰文件系统：策略拒绝时只得到 policy_denied", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "edit-tool-external-"));
  const outside = mkdtempSync(join(tmpdir(), "edit-tool-outside-"));
  writeFileSync(join(outside, "secret.txt"), "top secret\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir, maxFileBytes: 4 });
  const approvals: ApprovalRequest[] = [];
  const tools = buildEditFileTool(settings, new FileStateTracker(), new ToolRegistry(), {
    policy: { check: () => ({ action: "deny", reason: "外部路径禁止" }) },
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve({ approved: true });
    },
  });
  const editTool = tools.roll__edit_file;
  assert.ok(editTool?.execute !== undefined);
  for (const target of [join(outside, "secret.txt"), join(outside, "missing.txt"), outside]) {
    const result = (await editTool.execute(
      { file_path: target, edits: [{ old_string: "a", new_string: "b" }] },
      executeOptions(),
    )) as NormalizedToolResult;
    assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.policyDenied);
    assert.doesNotMatch(String(result.display), /文件不存在|是目录|文件过大|尚未读取过/u);
  }
  assert.equal(approvals.length, 0);
});

test("edit_file 执行时的实际变更与审批预览不一致则拒绝写入", async () => {
  const f = fixture("hello world\n");
  markRead(f);
  const previewed = executeEditFilePreviewFixture(f);
  writeFileSync(f.path, "hello universe\n", "utf8");
  f.tracker.recordKnownContent(canonicalFileKey(f.path), "hello universe\n");
  const result = executeEditFile(
    f.settings,
    f.tracker,
    { file_path: "target.txt", edits: [{ old_string: "hello", new_string: "goodbye" }] },
    previewed,
  );
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /与审批时预览的不一致/u);
  assert.equal(readFileSync(f.path, "utf8"), "hello universe\n");
});

test("edit_file 预览后其它位置发生无关改动（同批次独立编辑）时，相同的增删行仍可写入", async () => {
  const f = fixture("first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth\nninth\ntenth\n");
  markRead(f);
  const previewed = executeEditFilePreviewFixture(f, {
    file_path: "target.txt",
    edits: [{ old_string: "ninth", new_string: "NINTH" }],
  });
  const sibling = f.tracker;
  const afterSibling = readFileSync(f.path, "utf8").replace("first\n", "FIRST\nextra\n");
  writeFileSync(f.path, afterSibling, "utf8");
  sibling.recordKnownContent(canonicalFileKey(f.path), afterSibling);
  const result = executeEditFile(
    f.settings,
    f.tracker,
    { file_path: "target.txt", edits: [{ old_string: "ninth", new_string: "NINTH" }] },
    previewed,
  );
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.match(readFileSync(f.path, "utf8"), /FIRST\nextra\n[\s\S]*NINTH\n/u);
});

test("edit_file 同一批次内 write_file 改写后再 edit_file：预览与实际不一致的编辑被阻止，链式依赖的编辑照常成功", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "edit-tool-batch-"));
  const path = join(workdir, "t.txt");
  writeFileSync(path, "hello world\n", "utf8");
  const tracker = new FileStateTracker();
  tracker.recordKnownContent(canonicalFileKey(path), "hello world\n");
  const coordinator = new ToolExecutionCoordinator();
  const approvals: ApprovalRequest[] = [];
  const ctx = {
    policy: new DefaultToolPolicy(),
    requestApproval: (request: ApprovalRequest) => {
      approvals.push(request);
      return Promise.resolve({ approved: true });
    },
    approvalMemory: new SessionApprovalMemory(),
    coordinator,
  };
  const settings = resolveFileToolsSettings({ workdir });
  const registry = new ToolRegistry();
  const writeTool = buildWriteFileTool(settings, tracker, registry, ctx).roll__write_file;
  const editTool = buildEditFileTool(settings, tracker, registry, ctx).roll__edit_file;
  assert.ok(writeTool?.execute !== undefined && editTool?.execute !== undefined);
  const writeInput = { file_path: "t.txt", content: "hello universe\n" };
  const editInput = { file_path: "t.txt", edits: [{ old_string: "hello", new_string: "goodbye" }] };
  coordinator.startBatch("b1");
  await coordinator.prepare("w1", "roll__write_file", writeInput);
  await coordinator.prepare("e1", "roll__edit_file", editInput);
  coordinator.sealBatch("b1");
  assert.equal(approvals.length, 2);
  assert.match(approvals[1]?.diff?.unified ?? "", /-hello world\n\+goodbye world/u);
  const writeResult = (await writeTool.execute(writeInput, {
    toolCallId: "w1",
    messages: [],
    context: undefined,
  })) as NormalizedToolResult;
  assert.equal(writeResult.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const editResult = (await editTool.execute(editInput, {
    toolCallId: "e1",
    messages: [],
    context: undefined,
  })) as NormalizedToolResult;
  assert.equal(editResult.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(editResult.display), /与审批时预览的不一致/u);
  assert.equal(readFileSync(path, "utf8"), "hello universe\n");

  const chainA = { file_path: "t.txt", edits: [{ old_string: "hello", new_string: "bye" }] };
  const chainB = {
    file_path: "t.txt",
    edits: [{ old_string: "bye universe", new_string: "bye all" }],
  };
  coordinator.startBatch("b2");
  await coordinator.prepare("e2", "roll__edit_file", chainA);
  await coordinator.prepare("e3", "roll__edit_file", chainB);
  coordinator.sealBatch("b2");
  assert.equal(Object.hasOwn(approvals.at(-1) ?? {}, "diff"), false);
  const first = (await editTool.execute(chainA, {
    toolCallId: "e2",
    messages: [],
    context: undefined,
  })) as NormalizedToolResult;
  const second = (await editTool.execute(chainB, {
    toolCallId: "e3",
    messages: [],
    context: undefined,
  })) as NormalizedToolResult;
  assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(path, "utf8"), "bye all\n");
});

function executeEditFilePreviewFixture(
  f: Fixture,
  input = { file_path: "target.txt", edits: [{ old_string: "hello", new_string: "goodbye" }] },
): FileChangeDiff {
  const loaded = loadTextFile(f.path, { maxFileBytes: f.settings.maxFileBytes });
  assert.ok(loaded.ok);
  const plan = planEdits(loaded.content, input.edits);
  assert.ok(plan.ok);
  const diff = describeFileChange({
    workdir: f.workdir,
    inputPath: input.file_path,
    change: "modify",
    before: loaded.content,
    after: plan.next,
  });
  assert.ok(diff);
  return diff;
}

test("edit_file 审批期间文件被外部改动则不写入", async () => {
  const f = fixture("v1\n");
  markRead(f);
  const approvals: ApprovalRequest[] = [];
  const tools = buildEditFileTool(f.settings, f.tracker, new ToolRegistry(), {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      writeFileSync(f.path, "v1-external\n", "utf8");
      return Promise.resolve({ approved: true });
    },
    approvalMemory: new SessionApprovalMemory(),
  });
  const editTool = tools.roll__edit_file;
  assert.ok(editTool?.execute !== undefined);
  const result = (await editTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "v1", new_string: "v2" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(approvals.length, 1);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /已被修改/u);
  assert.equal(readFileSync(f.path, "utf8"), "v1-external\n");
});
