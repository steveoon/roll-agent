import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { SessionApprovalMemory } from "../../approval/approval-memory.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import { ToolRegistry } from "../naming.ts";
import { TOOL_OUTCOME_KINDS, type NormalizedToolResult } from "../normalize-result.ts";
import { ToolExecutionCoordinator } from "../tool-execution-coordinator.ts";
import { buildEditFileTool, type EditFileInput } from "./edit-file-tool.ts";
import { buildWriteFileTool } from "./write-file-tool.ts";
import { canonicalFileKey } from "./file-io.ts";
import { FileStateTracker } from "./file-state-tracker.ts";
import { resolveFileToolsSettings } from "./settings.ts";

const options = (toolCallId: string) => ({ toolCallId, messages: [], context: undefined });

for (const toolName of ["roll__edit_file", "roll__write_file"] as const) {
  test(`${toolName} 批准后复用原预览，不因执行期 diff 超时改变统计`, async (t) => {
    const workdir = mkdtempSync(join(tmpdir(), "roll-approved-diff-"));
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    const path = join(workdir, "target.txt");
    const before = "before\nunchanged\n";
    const after = "after\nunchanged\n";
    writeFileSync(path, before);
    const tracker = new FileStateTracker();
    tracker.recordKnownContent(canonicalFileKey(path), before);
    const approvals: ApprovalRequest[] = [];
    const ctx = {
      policy: new DefaultToolPolicy(),
      requestApproval: async (request: ApprovalRequest) => {
        approvals.push(request);
        // A later rendering attempt would exhaust its deadline; the approved snapshot stays valid.
        let now = Date.now();
        t.mock.method(Date, "now", () => (now += 2_000));
        return { approved: true };
      },
    };
    const registry = new ToolRegistry();
    const settings = resolveFileToolsSettings({ workdir });
    const built = {
      ...buildEditFileTool(settings, tracker, registry, ctx),
      ...buildWriteFileTool(settings, tracker, registry, ctx),
    };
    const executable = built[toolName];
    assert.ok(executable?.execute);
    const input =
      toolName === "roll__edit_file"
        ? { file_path: "target.txt", edits: [{ old_string: "before", new_string: "after" }] }
        : { file_path: "target.txt", content: after };
    const result = (await executable.execute(input, options("a"))) as NormalizedToolResult;
    assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
    assert.equal(readFileSync(path, "utf8"), after);
    assert.equal(approvals[0]?.diff?.coarse, undefined);
    assert.deepEqual((result.display as { diff: unknown }).diff, approvals[0]?.diff);
  });
}

for (const scenario of [
  {
    name: "目标移入另一个上下文",
    before: 'scheduler\nMODE = "dry-run"\nfixture\n',
    afterFirst: 'scheduler\nfixture\nMODE = "dry-run"\n',
    edits: [{ old_string: 'MODE = "dry-run"', new_string: 'MODE = "live"' }],
  },
  {
    name: "replace_all 新增匹配位于截断后",
    before: Array.from({ length: 200 }, (_, i) => `line ${i}: TOKEN ${"x".repeat(80)}\n`).join(""),
    afterFirst:
      Array.from({ length: 200 }, (_, i) => `line ${i}: TOKEN ${"x".repeat(80)}\n`).join("") +
      "late TOKEN\n",
    edits: [{ old_string: "TOKEN", new_string: "VALUE", replace_all: true }],
  },
  {
    name: "大文件无 inline unified，增删行数相同",
    before: `${"padding\n".repeat(80_000)}original\nMODE=dry\n`,
    afterFirst: `${"padding\n".repeat(80_000)}different\nMODE=dry\n`,
    edits: [{ old_string: "MODE=dry", new_string: "MODE=live" }],
  },
  {
    name: "仅 BOM 改变",
    before: "MODE=dry\n",
    afterFirst: "\uFEFFMODE=dry\n",
    edits: [{ old_string: "MODE=dry", new_string: "MODE=live" }],
  },
] satisfies readonly {
  name: string;
  before: string;
  afterFirst: string;
  edits: EditFileInput["edits"];
}[]) {
  test(`审批基准不随同批次 tracker 更新：${scenario.name}`, async (t) => {
    const workdir = mkdtempSync(join(tmpdir(), "roll-approval-version-"));
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    const path = join(workdir, "target.txt");
    writeFileSync(path, scenario.before);
    const tracker = new FileStateTracker();
    tracker.recordKnownContent(canonicalFileKey(path), scenario.before);
    const coordinator = new ToolExecutionCoordinator();
    const approvals: ApprovalRequest[] = [];
    const ctx = {
      policy: new DefaultToolPolicy(),
      requestApproval: async (request: ApprovalRequest) => {
        approvals.push(request);
        return { approved: true };
      },
      approvalMemory: new SessionApprovalMemory(),
      coordinator,
    };
    const registry = new ToolRegistry();
    const settings = resolveFileToolsSettings({ workdir });
    const write = buildWriteFileTool(settings, tracker, registry, ctx).roll__write_file;
    const edit = buildEditFileTool(settings, tracker, registry, ctx).roll__edit_file;
    assert.ok(write?.execute && edit?.execute);
    const a = { file_path: "target.txt", content: scenario.afterFirst };
    const b = { file_path: "target.txt", edits: scenario.edits };
    coordinator.startBatch("batch");
    await coordinator.prepare("a", "roll__write_file", a);
    await coordinator.prepare("b", "roll__edit_file", b);
    coordinator.sealBatch("batch");
    assert.equal(approvals.length, 2);
    const first = (await write.execute(a, options("a"))) as NormalizedToolResult;
    const second = (await edit.execute(b, options("b"))) as NormalizedToolResult;
    assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
    assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
    assert.equal(readFileSync(path, "utf8"), scenario.afterFirst);
  });
}

for (const initiallyExists of [false, true]) {
  test(`write_file 审批绑定${initiallyExists ? "原始内容" : "文件不存在"}，不接受前次写入更新的 tracker`, async (t) => {
    const workdir = mkdtempSync(join(tmpdir(), "roll-write-version-"));
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    const path = join(workdir, "target.txt");
    const tracker = new FileStateTracker();
    if (initiallyExists) {
      writeFileSync(path, "before\n");
      tracker.recordKnownContent(canonicalFileKey(path), "before\n");
    }
    const coordinator = new ToolExecutionCoordinator();
    const write = buildWriteFileTool(
      resolveFileToolsSettings({ workdir }),
      tracker,
      new ToolRegistry(),
      {
        coordinator,
        policy: new DefaultToolPolicy(),
        requestApproval: async () => ({ approved: true }),
      },
    ).roll__write_file;
    assert.ok(write?.execute);
    const a = { file_path: "target.txt", content: "first\n" };
    const b = { file_path: "target.txt", content: "second\n" };
    coordinator.startBatch("batch");
    await coordinator.prepare("a", "roll__write_file", a);
    await coordinator.prepare("b", "roll__write_file", b);
    coordinator.sealBatch("batch");
    assert.equal(
      ((await write.execute(a, options("a"))) as NormalizedToolResult).outcome.kind,
      TOOL_OUTCOME_KINDS.success,
    );
    assert.equal(
      ((await write.execute(b, options("b"))) as NormalizedToolResult).outcome.kind,
      TOOL_OUTCOME_KINDS.toolFailed,
    );
    assert.equal(readFileSync(path, "utf8"), "first\n");
  });
}
