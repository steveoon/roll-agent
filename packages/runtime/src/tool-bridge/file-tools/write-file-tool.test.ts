import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey } from "./file-io.ts";
import { resolveFileToolsSettings } from "./settings.ts";
import { buildWriteFileTool, executeWriteFile } from "./write-file-tool.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { SessionApprovalMemory } from "../../approval/approval-memory.ts";
import { TOOL_OUTCOME_KINDS, type NormalizedToolResult } from "../normalize-result.ts";

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

test("覆盖带 BOM 的已存在文件后新文件不带 BOM", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const path = join(workdir, "exists.txt");
  writeFileSync(path, "\uFEFF旧内容", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const tracker = new FileStateTracker();
  tracker.recordKnownContent(canonicalFileKey(path), "旧内容");
  const result = executeWriteFile(settings, tracker, {
    file_path: "exists.txt",
    content: "新内容",
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const firstThreeBytes = readFileSync(path).subarray(0, 3);
  assert.equal(firstThreeBytes.equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(readFileSync(path, "utf8"), "新内容");
});

function executeOptions(
  overrides: Partial<ToolExecutionOptions<unknown>> = {},
): ToolExecutionOptions<unknown> {
  return { toolCallId: "call-1", messages: [], context: undefined, ...overrides };
}

function buildWriteFixture(
  workdir: string,
  tracker: FileStateTracker,
  approvals: ApprovalRequest[],
  memory: SessionApprovalMemory,
) {
  const registry = new ToolRegistry();
  const settings = resolveFileToolsSettings({ workdir });
  return buildWriteFileTool(settings, tracker, registry, {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve({ approved: true, scope: "session" });
    },
    approvalMemory: memory,
  });
}

test("缩水覆盖即使记忆已授权仍会弹出确认，explanation 提示有意删减", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-shrink-test-"));
  const path = join(workdir, "big.txt");
  const originalLines = Array.from({ length: 30 }, (_, index) => `第${String(index + 1)}行`);
  writeFileSync(path, originalLines.join("\n"), "utf8");
  const tracker = new FileStateTracker();
  tracker.recordKnownContent(canonicalFileKey(path), originalLines.join("\n"));
  const approvals: ApprovalRequest[] = [];
  const memory = new SessionApprovalMemory();
  memory.grant("write_file:workdir");
  const tools = buildWriteFixture(workdir, tracker, approvals, memory);
  const writeTool = tools.roll__write_file;
  assert.ok(writeTool?.execute !== undefined);
  const newLines = Array.from({ length: 5 }, (_, index) => `新${String(index + 1)}行`);
  const result = (await writeTool.execute(
    { file_path: "big.txt", content: newLines.join("\n") },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  assert.match(approvals[0]?.explanation ?? "", /有意删减/u);
});

test("未读取过的文件即使缩水也在弹窗前被 read-before-overwrite 拦下", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-unread-shrink-"));
  const path = join(workdir, "big.txt");
  const originalLines = Array.from({ length: 30 }, (_, index) => `第${String(index + 1)}行`);
  writeFileSync(path, originalLines.join("\n"), "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildWriteFixture(
    workdir,
    new FileStateTracker(),
    approvals,
    new SessionApprovalMemory(),
  );
  const writeTool = tools.roll__write_file;
  assert.ok(writeTool?.execute !== undefined);
  const result = (await writeTool.execute(
    { file_path: "big.txt", content: "只剩一行" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /先用 roll__read_file/u);
  assert.equal(approvals.length, 0);
  assert.equal(readFileSync(path, "utf8"), originalLines.join("\n"));
});

test("symlink 目录写入时 explanation 含 outside 的真实路径", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "write-tool-symlink-expl-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "write-tool-symlink-out-")));
  symlinkSync(outside, join(workdir, "out"));
  const approvals: ApprovalRequest[] = [];
  const tools = buildWriteFixture(
    workdir,
    new FileStateTracker(),
    approvals,
    new SessionApprovalMemory(),
  );
  const writeTool = tools.roll__write_file;
  assert.ok(writeTool?.execute !== undefined);
  const result = (await writeTool.execute(
    { file_path: "out/secret.txt", content: "x\n" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  assert.match(
    approvals[0]?.explanation ?? "",
    new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"),
  );
  assert.match(approvals[0]?.explanation ?? "", /secret\.txt（工作目录外）/u);
});

test("确认期间 external symlink 改指向另一外部目录时阻止写入", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "write-tool-retarget-wd-")));
  const outsideA = realpathSync(mkdtempSync(join(tmpdir(), "write-tool-retarget-a-")));
  const outsideB = realpathSync(mkdtempSync(join(tmpdir(), "write-tool-retarget-b-")));
  symlinkSync(outsideA, join(workdir, "out"));
  const approvals: ApprovalRequest[] = [];
  const tools = buildWriteFileTool(
    resolveFileToolsSettings({ workdir }),
    new FileStateTracker(),
    new ToolRegistry(),
    {
      policy: new DefaultToolPolicy(),
      requestApproval: (request) => {
        approvals.push(request);
        rmSync(join(workdir, "out"));
        symlinkSync(outsideB, join(workdir, "out"));
        return Promise.resolve({ approved: true });
      },
      approvalMemory: new SessionApprovalMemory(),
    },
  );
  const writeTool = tools.roll__write_file;
  assert.ok(writeTool?.execute !== undefined);
  const result = (await writeTool.execute(
    { file_path: "out/secret.txt", content: "secret\n" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /安全条件.*变化/u);
  assert.equal(approvals.length, 1);
  assert.match(approvals[0]?.explanation ?? "", /secret\.txt（工作目录外）/u);
  assert.equal(existsSync(join(outsideA, "secret.txt")), false);
  assert.equal(existsSync(join(outsideB, "secret.txt")), false);
});

test("external write 选 session 后再写另一个 external 路径仍弹窗", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-ext-mem-"));
  const outsideA = mkdtempSync(join(tmpdir(), "write-tool-ext-a-"));
  const outsideB = mkdtempSync(join(tmpdir(), "write-tool-ext-b-"));
  const approvals: ApprovalRequest[] = [];
  const memory = new SessionApprovalMemory();
  const tools = buildWriteFixture(workdir, new FileStateTracker(), approvals, memory);
  const writeTool = tools.roll__write_file;
  assert.ok(writeTool?.execute !== undefined);
  const first = (await writeTool.execute(
    { file_path: join(outsideA, "a.txt"), content: "one\n" },
    executeOptions({ toolCallId: "e1" }),
  )) as NormalizedToolResult;
  assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  const second = (await writeTool.execute(
    { file_path: join(outsideB, "b.txt"), content: "two\n" },
    executeOptions({ toolCallId: "e2" }),
  )) as NormalizedToolResult;
  assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 2);
});

test("非缩水覆盖命中已授权记忆，不再弹出确认", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-shrink-test-"));
  const path = join(workdir, "small.txt");
  const originalLines = Array.from({ length: 25 }, (_, index) => `第${String(index + 1)}行`);
  writeFileSync(path, originalLines.join("\n"), "utf8");
  const tracker = new FileStateTracker();
  tracker.recordKnownContent(canonicalFileKey(path), originalLines.join("\n"));
  const approvals: ApprovalRequest[] = [];
  const memory = new SessionApprovalMemory();
  memory.grant("write_file:workdir");
  const tools = buildWriteFixture(workdir, tracker, approvals, memory);
  const writeTool = tools.roll__write_file;
  assert.ok(writeTool?.execute !== undefined);
  const newLines = Array.from({ length: 25 }, (_, index) => `改${String(index + 1)}行`);
  const result = (await writeTool.execute(
    { file_path: "small.txt", content: newLines.join("\n") },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 0);
});
