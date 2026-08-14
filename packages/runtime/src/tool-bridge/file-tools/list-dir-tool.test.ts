import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { resolveFileToolsSettings } from "./settings.ts";
import { buildListDirTool, executeListDir } from "./list-dir-tool.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { SessionApprovalMemory } from "../../approval/approval-memory.ts";
import { TOOL_OUTCOME_KINDS, type NormalizedToolResult } from "../normalize-result.ts";

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

function executeOptions(
  overrides: Partial<ToolExecutionOptions<unknown>> = {},
): ToolExecutionOptions<unknown> {
  return { toolCallId: "call-1", messages: [], context: undefined, ...overrides };
}

function buildListDirFixture(
  workdir: string,
  approvals: ApprovalRequest[],
  approve: boolean,
  options: { readonly scope?: "once" | "session"; readonly memory?: SessionApprovalMemory } = {},
) {
  const registry = new ToolRegistry();
  const settings = resolveFileToolsSettings({ workdir });
  return buildListDirTool(settings, registry, {
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

test("workdir 外绝对路径触发确认门，拒绝时返回 user_rejected", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "list-dir-gate-test-")));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "list-dir-outside-test-")));
  const approvals: ApprovalRequest[] = [];
  const tools = buildListDirFixture(workdir, approvals, false);
  const listTool = tools.roll__list_dir;
  assert.ok(listTool?.execute !== undefined);
  const result = (await listTool.execute(
    { path: outsideDir },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.userRejected);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.toolName, "list_dir");
  assert.equal(approvals[0]?.reason, "读取工作目录以外的文件");
});

test("workdir 外绝对路径批准后可正常列出", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "list-dir-gate-test-")));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "list-dir-outside-test-")));
  writeFileSync(join(outsideDir, "a.txt"), "hello", "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildListDirFixture(workdir, approvals, true);
  const listTool = tools.roll__list_dir;
  assert.ok(listTool?.execute !== undefined);
  const result = (await listTool.execute(
    { path: outsideDir },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
});

test("workdir 内路径不触发确认门", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "list-dir-gate-test-")));
  writeFileSync(join(workdir, "a.txt"), "hello", "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildListDirFixture(workdir, approvals, true);
  const listTool = tools.roll__list_dir;
  assert.ok(listTool?.execute !== undefined);
  const result = (await listTool.execute({}, executeOptions())) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 0);
});

test("workdir 外路径 scope=session 批准后第二次列目录免弹", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "list-dir-gate-test-")));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "list-dir-outside-test-")));
  writeFileSync(join(outsideDir, "a.txt"), "hello", "utf8");
  const approvals: ApprovalRequest[] = [];
  const memory = new SessionApprovalMemory();
  const tools = buildListDirFixture(workdir, approvals, true, { scope: "session", memory });
  const listTool = tools.roll__list_dir;
  assert.ok(listTool?.execute !== undefined);
  const first = (await listTool.execute(
    { path: outsideDir },
    executeOptions({ toolCallId: "t1" }),
  )) as NormalizedToolResult;
  assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  const second = (await listTool.execute(
    { path: outsideDir },
    executeOptions({ toolCallId: "t2" }),
  )) as NormalizedToolResult;
  assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
});
