import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { FILE_FRESHNESS, FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey } from "./file-io.ts";
import { resolveFileToolsSettings } from "./settings.ts";
import { buildReadFileTool, executeReadFile } from "./read-file-tool.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { TOOL_OUTCOME_KINDS, type NormalizedToolResult } from "../normalize-result.ts";

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

test("offset 越界的 read 不解锁编辑：tracker 仍为 unread", () => {
  const { workdir, tracker } = fixture();
  const path = join(workdir, "c.txt");
  writeFileSync(path, "only", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "c.txt", offset: 9 });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.equal(tracker.checkFreshness(canonicalFileKey(path), "only"), FILE_FRESHNESS.unread);
});

test("超长单行被截断标注", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "d.txt"), "x".repeat(1500), "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const text = String(executeReadFile(settings, tracker, { path: "d.txt" }).display);
  assert.match(text, /\[行截断\]/u);
});

function executeOptions(
  overrides: Partial<ToolExecutionOptions<unknown>> = {},
): ToolExecutionOptions<unknown> {
  return { toolCallId: "call-1", messages: [], context: undefined, ...overrides };
}

function buildReadFixture(
  workdir: string,
  tracker: FileStateTracker,
  approvals: ApprovalRequest[],
  approve: boolean,
) {
  const registry = new ToolRegistry();
  const settings = resolveFileToolsSettings({ workdir });
  return buildReadFileTool(settings, tracker, registry, {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve({ approved: approve });
    },
  });
}

test("workdir 外绝对路径触发确认门，拒绝时返回 user_rejected 且不记录 tracker", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "read-tool-gate-test-")));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "read-tool-outside-test-")));
  const outsidePath = join(outsideDir, "secret.txt");
  writeFileSync(outsidePath, "秘密内容", "utf8");
  const tracker = new FileStateTracker();
  const approvals: ApprovalRequest[] = [];
  const tools = buildReadFixture(workdir, tracker, approvals, false);
  const readTool = tools.roll__read_file;
  assert.ok(readTool?.execute !== undefined);
  const result = (await readTool.execute(
    { path: outsidePath },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.userRejected);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.toolName, "read_file");
  assert.equal(approvals[0]?.reason, "读取工作目录以外的文件");
  assert.equal(
    tracker.checkFreshness(canonicalFileKey(outsidePath), "秘密内容"),
    FILE_FRESHNESS.unread,
  );
});

test("workdir 外绝对路径批准后可正常读取", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "read-tool-gate-test-")));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "read-tool-outside-test-")));
  const outsidePath = join(outsideDir, "allowed.txt");
  writeFileSync(outsidePath, "内容", "utf8");
  const tracker = new FileStateTracker();
  const approvals: ApprovalRequest[] = [];
  const tools = buildReadFixture(workdir, tracker, approvals, true);
  const readTool = tools.roll__read_file;
  assert.ok(readTool?.execute !== undefined);
  const result = (await readTool.execute(
    { path: outsidePath },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  assert.equal(tracker.checkFreshness(canonicalFileKey(outsidePath), "内容"), FILE_FRESHNESS.fresh);
});

test("workdir 内路径不触发确认门", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "read-tool-gate-test-")));
  writeFileSync(join(workdir, "inside.txt"), "内容", "utf8");
  const tracker = new FileStateTracker();
  const approvals: ApprovalRequest[] = [];
  const tools = buildReadFixture(workdir, tracker, approvals, true);
  const readTool = tools.roll__read_file;
  assert.ok(readTool?.execute !== undefined);
  const result = (await readTool.execute(
    { path: "inside.txt" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 0);
});
