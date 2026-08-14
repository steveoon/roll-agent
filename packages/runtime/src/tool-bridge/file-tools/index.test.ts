import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { SessionApprovalMemory } from "../../approval/approval-memory.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import type { NormalizedToolResult } from "../normalize-result.ts";
import { buildFileToolset } from "./index.ts";

function executeOptions(
  overrides: Partial<ToolExecutionOptions<unknown>> = {},
): ToolExecutionOptions<unknown> {
  return { toolCallId: "call-1", messages: [], context: undefined, ...overrides };
}

function buildFixture(workdir: string, memory?: SessionApprovalMemory) {
  const approvals: ApprovalRequest[] = [];
  const registry = new ToolRegistry();
  const toolset = buildFileToolset({ workdir }, registry, {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve({ approved: true, scope: "session" });
    },
    ...(memory ? { approvalMemory: memory } : {}),
  });
  return { approvals, registry, toolset };
}

test("注册四个 roll__ 前缀工具并按读写分组", () => {
  const workdir = mkdtempSync(join(tmpdir(), "file-toolset-test-"));
  const { toolset } = buildFixture(workdir);
  assert.deepEqual(Object.keys(toolset.readTools).sort(), ["roll__list_dir", "roll__read_file"]);
  assert.deepEqual(Object.keys(toolset.editTools).sort(), ["roll__edit_file", "roll__write_file"]);
});

test("read 与 edit 共享同一 tracker：读后即可编辑", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "file-toolset-test-"));
  writeFileSync(join(workdir, "a.txt"), "原文", "utf8");
  const { approvals, toolset } = buildFixture(workdir);
  const readTool = toolset.readTools.roll__read_file;
  const editTool = toolset.editTools.roll__edit_file;
  assert.ok(readTool?.execute !== undefined && editTool?.execute !== undefined);
  const readResult = (await readTool.execute(
    { path: "a.txt" },
    executeOptions({ toolCallId: "t1" }),
  )) as NormalizedToolResult;
  assert.equal(readResult.outcome.kind, "success");
  const editResult = (await editTool.execute(
    { file_path: "a.txt", edits: [{ old_string: "原文", new_string: "改后" }] },
    executeOptions({ toolCallId: "t2" }),
  )) as NormalizedToolResult;
  assert.equal(editResult.outcome.kind, "success");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.toolName, "edit_file");
});

test("workdir 内 edit 经 scope=session 批准后写入记忆，第二次编辑免弹", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "file-toolset-test-"));
  writeFileSync(join(workdir, "a.txt"), "第一行\n第二行", "utf8");
  const memory = new SessionApprovalMemory();
  const { approvals, toolset } = buildFixture(workdir, memory);
  const readTool = toolset.readTools.roll__read_file;
  const editTool = toolset.editTools.roll__edit_file;
  assert.ok(readTool?.execute !== undefined && editTool?.execute !== undefined);
  await readTool.execute({ path: "a.txt" }, executeOptions({ toolCallId: "r1" }));
  const first = (await editTool.execute(
    { file_path: "a.txt", edits: [{ old_string: "第一行", new_string: "改后一" }] },
    executeOptions({ toolCallId: "e1" }),
  )) as NormalizedToolResult;
  assert.equal(first.outcome.kind, "success");
  assert.equal(approvals.length, 1);
  const second = (await editTool.execute(
    { file_path: "a.txt", edits: [{ old_string: "第二行", new_string: "改后二" }] },
    executeOptions({ toolCallId: "e2" }),
  )) as NormalizedToolResult;
  assert.equal(second.outcome.kind, "success");
  assert.equal(approvals.length, 1);
});
