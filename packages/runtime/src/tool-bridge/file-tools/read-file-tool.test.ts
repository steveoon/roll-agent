import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, ToolExecutionOptions } from "ai";
import { relocateToolImagesToUserMessages } from "../../engine/relocate-tool-images.ts";
import { FILE_FRESHNESS, FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey } from "./file-io.ts";
import { resolveFileToolsSettings } from "./settings.ts";
import { buildReadFileTool, executeReadFile } from "./read-file-tool.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { SessionApprovalMemory } from "../../approval/approval-memory.ts";
import { TOOL_OUTCOME_KINDS, type NormalizedToolResult } from "../normalize-result.ts";
import { ToolExecutionCoordinator } from "../tool-execution-coordinator.ts";

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

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("读取 PNG 图片以图像内容进入 model output，offset/limit 被忽略", () => {
  const { workdir, tracker } = fixture();
  const path = join(workdir, "shot.png");
  writeFileSync(path, Buffer.from(PNG_1X1_BASE64, "base64"));
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "shot.png", offset: 5, limit: 1 });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.match(String(result.display), /图像文件/u);
  assert.equal(result.model.type, "content");
  const parts = result.model.type === "content" ? result.model.value : [];
  const filePart = parts.find((part) => part.type === "file");
  assert.ok(filePart !== undefined && filePart.type === "file");
  assert.equal(filePart.mediaType, "image/png");
  assert.equal(filePart.data.data, PNG_1X1_BASE64);
});

test("read_file 图像输出可被 relocateToolImagesToUserMessages 搬进 user message", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "shot.png"), Buffer.from(PNG_1X1_BASE64, "base64"));
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "shot.png" });
  const messages = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "roll__read_file",
          output: result.model,
        },
      ],
    },
  ] as unknown as ModelMessage[];
  const relocated = relocateToolImagesToUserMessages(messages);
  assert.equal(relocated.length, 2);
  const userMessage = relocated[1];
  assert.ok(userMessage !== undefined && userMessage.role === "user");
  const userParts = userMessage.content as unknown as Array<Record<string, unknown>>;
  const filePart = userParts.find((part) => part["type"] === "file");
  assert.ok(filePart !== undefined);
  assert.equal(filePart["data"], PNG_1X1_BASE64);
  assert.equal(filePart["mediaType"], "image/png");
});

test("图片超出 maxImageFileBytes 返回 invalid_input 并说明过大", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "big.png"), Buffer.from(PNG_1X1_BASE64, "base64"));
  const settings = resolveFileToolsSettings({ workdir, maxImageFileBytes: 16 });
  const result = executeReadFile(settings, tracker, { path: "big.png" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(result.display), /过大/u);
});

test("以 GIF89a 开头的 UTF-8 文本走文本路径且可解锁编辑", () => {
  const { workdir, tracker } = fixture();
  const path = join(workdir, "gif-notes.md");
  const content = "GIF89a 是 GIF 格式的版本标识\n第二行说明";
  writeFileSync(path, content, "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "gif-notes.md" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.notEqual(result.model.type, "content");
  assert.match(String(result.display), / {4}1→GIF89a/u);
  assert.equal(tracker.checkFreshness(canonicalFileKey(path), content), FILE_FRESHNESS.fresh);
});

test("截断的 PNG 返回 invalid_input 并提示损坏", () => {
  const { workdir, tracker } = fixture();
  const fullPng = Buffer.from(PNG_1X1_BASE64, "base64");
  writeFileSync(join(workdir, "half.png"), fullPng.subarray(0, fullPng.length - 8));
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "half.png" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(result.display), /截断|损坏/u);
});

test("伪装成 .png 的文本文件仍走文本路径", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "fake.png"), "第一行\n第二行", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "fake.png" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.match(String(result.display), / {4}1→第一行/u);
  assert.notEqual(result.model.type, "content");
});

test("无图像签名的二进制文件仍被拒绝", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "blob.bin" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.match(String(result.display), /二进制/u);
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
  options: { readonly scope?: "once" | "session"; readonly memory?: SessionApprovalMemory } = {},
) {
  const registry = new ToolRegistry();
  const settings = resolveFileToolsSettings({ workdir });
  return buildReadFileTool(settings, tracker, registry, {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve(
        options.scope !== undefined
          ? { approved: approve, scope: options.scope }
          : { approved: approve },
      );
    },
    ...(options.memory ? { approvalMemory: options.memory } : {}),
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

test(
  "准入后内部文件换成越界 symlink 时执行前阻止读取",
  { skip: process.platform === "win32" },
  async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "read-tool-drift-workdir-")));
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "read-tool-drift-outside-")));
    const admittedPath = join(workdir, "notes.txt");
    const outsidePath = join(outsideDir, "secret.txt");
    writeFileSync(admittedPath, "inside", "utf8");
    writeFileSync(outsidePath, "LEAKED_SECRET", "utf8");
    const tracker = new FileStateTracker();
    const approvals: ApprovalRequest[] = [];
    const coordinator = new ToolExecutionCoordinator();
    const tools = buildReadFileTool(
      resolveFileToolsSettings({ workdir }),
      tracker,
      new ToolRegistry(),
      {
        policy: new DefaultToolPolicy(),
        requestApproval: (request) => {
          approvals.push(request);
          return Promise.resolve({ approved: true });
        },
        coordinator,
      },
    );
    const readTool = tools.roll__read_file;
    assert.ok(readTool?.execute !== undefined);
    const input = { path: "notes.txt" };
    const toolCallId = "read-file-admission-drift";
    await coordinator.prepare(toolCallId, "roll__read_file", input);
    assert.equal(approvals.length, 0);
    unlinkSync(admittedPath);
    symlinkSync(outsidePath, admittedPath);

    const result = (await readTool.execute(
      input,
      executeOptions({ toolCallId }),
    )) as NormalizedToolResult;

    assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
    assert.match(String(result.display), /安全条件.*变化/u);
    assert.doesNotMatch(String(result.display), /LEAKED_SECRET/u);
    assert.equal(
      tracker.checkFreshness(canonicalFileKey(admittedPath), "LEAKED_SECRET"),
      FILE_FRESHNESS.unread,
    );
  },
);

test("workdir 外路径 scope=session 批准后第二次读取免弹", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "read-tool-gate-test-")));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "read-tool-outside-test-")));
  const outsidePath = join(outsideDir, "allowed.txt");
  writeFileSync(outsidePath, "内容", "utf8");
  const tracker = new FileStateTracker();
  const approvals: ApprovalRequest[] = [];
  const memory = new SessionApprovalMemory();
  const tools = buildReadFixture(workdir, tracker, approvals, true, { scope: "session", memory });
  const readTool = tools.roll__read_file;
  assert.ok(readTool?.execute !== undefined);
  const first = (await readTool.execute(
    { path: outsidePath },
    executeOptions({ toolCallId: "t1" }),
  )) as NormalizedToolResult;
  assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  const second = (await readTool.execute(
    { path: outsidePath },
    executeOptions({ toolCallId: "t2" }),
  )) as NormalizedToolResult;
  assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
});
