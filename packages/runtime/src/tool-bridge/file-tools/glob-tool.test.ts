import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { resolveFileToolsSettings } from "./settings.ts";
import { buildGlobTool, executeGlob } from "./glob-tool.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { SessionApprovalMemory } from "../../approval/approval-memory.ts";
import { TOOL_OUTCOME_KINDS, type NormalizedToolResult } from "../normalize-result.ts";
import { ToolExecutionCoordinator } from "../tool-execution-coordinator.ts";

function fixtureWorkdir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("pattern 过滤正确性：仅命中匹配 glob 的文件，支持 ** 递归子目录", async () => {
  const workdir = fixtureWorkdir("glob-filter-");
  mkdirSync(join(workdir, "sub"), { recursive: true });
  const rootMd = join(workdir, "a.md");
  const nestedMd = join(workdir, "sub", "b.md");
  const rootTxt = join(workdir, "c.txt");
  writeFileSync(rootMd, "x", "utf8");
  writeFileSync(nestedMd, "x", "utf8");
  writeFileSync(rootTxt, "x", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGlob(settings, { pattern: "**/*.md" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.ok(text.includes(rootMd));
  assert.ok(text.includes(nestedMd));
  assert.ok(!text.includes(rootTxt));
});

test("命中按修改时间降序排序，新文件排在旧文件前面", async () => {
  const workdir = fixtureWorkdir("glob-mtime-");
  const olderPath = join(workdir, "older.md");
  const newerPath = join(workdir, "newer.md");
  writeFileSync(olderPath, "old", "utf8");
  writeFileSync(newerPath, "new", "utf8");
  const older = new Date("2024-01-01T00:00:00Z");
  const newer = new Date("2024-06-01T00:00:00Z");
  utimesSync(olderPath, older, older);
  utimesSync(newerPath, newer, newer);
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGlob(settings, { pattern: "*.md" });
  const text = String(result.display);
  const newerIndex = text.indexOf(newerPath);
  const olderIndex = text.indexOf(olderPath);
  assert.ok(newerIndex >= 0);
  assert.ok(olderIndex >= 0);
  assert.ok(newerIndex < olderIndex);
});

test("超过 200 个文件时按 mtime 截断为前 200 并提示总数", async () => {
  const workdir = fixtureWorkdir("glob-cap-");
  const total = 205;
  const now = Date.now();
  for (let index = 0; index < total; index += 1) {
    const filePath = join(workdir, `f${String(index).padStart(3, "0")}.md`);
    writeFileSync(filePath, "x", "utf8");
    const mtime = new Date(now - index * 1000);
    utimesSync(filePath, mtime, mtime);
  }
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGlob(settings, { pattern: "*.md" });
  const text = String(result.display);
  const lines = text.split("\n").filter((line) => line.startsWith(workdir));
  assert.equal(lines.length, 200);
  assert.ok(text.includes(join(workdir, "f000.md")));
  assert.ok(text.includes(join(workdir, "f199.md")));
  assert.ok(!text.includes(join(workdir, "f200.md")));
  assert.ok(!text.includes(join(workdir, "f204.md")));
  assert.match(text, /共 205 个文件，仅显示前 200 个（按修改时间倒序）/u);
});

test("0 命中返回明确提示", async () => {
  const workdir = fixtureWorkdir("glob-nohit-");
  writeFileSync(join(workdir, "a.txt"), "content", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGlob(settings, { pattern: "*.md" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(String(result.display), "未找到匹配 *.md 的文件。");
});

test("path 指向不存在的目录时返回 tool_failed（rg 层执行失败）", async () => {
  const workdir = fixtureWorkdir("glob-badpath-");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGlob(settings, {
    pattern: "*.md",
    path: join(workdir, "does-not-exist"),
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
});

test("path 指向已存在的文件而非目录时返回 invalid_input 并引导至 roll__read_file", async () => {
  const workdir = fixtureWorkdir("glob-filepath-");
  const filePath = join(workdir, "a.md");
  writeFileSync(filePath, "x", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGlob(settings, { pattern: "*.zzznomatch", path: filePath });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  const text = String(result.display);
  assert.ok(text.includes(filePath));
  assert.ok(text.includes("roll__read_file"));
});

function executeOptions(
  overrides: Partial<ToolExecutionOptions<unknown>> = {},
): ToolExecutionOptions<unknown> {
  return { toolCallId: "call-1", messages: [], context: undefined, ...overrides };
}

function buildGlobFixture(
  workdir: string,
  approvals: ApprovalRequest[],
  approve: boolean,
  options: { readonly scope?: "once" | "session"; readonly memory?: SessionApprovalMemory } = {},
) {
  const registry = new ToolRegistry();
  const settings = resolveFileToolsSettings({ workdir });
  return buildGlobTool(settings, registry, {
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

test("workdir 外路径触发确认门，拒绝时返回 user_rejected", async () => {
  const workdir = fixtureWorkdir("glob-gate-");
  const outsideDir = fixtureWorkdir("glob-outside-");
  writeFileSync(join(outsideDir, "secret.md"), "x", "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildGlobFixture(workdir, approvals, false);
  const globTool = tools.roll__glob;
  assert.ok(globTool?.execute !== undefined);
  const result = (await globTool.execute(
    { pattern: "*.md", path: outsideDir },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.userRejected);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.toolName, "glob");
  assert.equal(approvals[0]?.reason, "读取工作目录以外的文件");
});

test("workdir 外路径批准后可正常查找", async () => {
  const workdir = fixtureWorkdir("glob-gate-");
  const outsideDir = fixtureWorkdir("glob-outside-");
  writeFileSync(join(outsideDir, "secret.md"), "x", "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildGlobFixture(workdir, approvals, true);
  const globTool = tools.roll__glob;
  assert.ok(globTool?.execute !== undefined);
  const result = (await globTool.execute(
    { pattern: "*.md", path: outsideDir },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  assert.ok(String(result.display).includes(join(outsideDir, "secret.md")));
});

test("workdir 内路径不触发确认门", async () => {
  const workdir = fixtureWorkdir("glob-gate-");
  writeFileSync(join(workdir, "a.md"), "x", "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildGlobFixture(workdir, approvals, true);
  const globTool = tools.roll__glob;
  assert.ok(globTool?.execute !== undefined);
  const result = (await globTool.execute(
    { pattern: "*.md" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 0);
});

test(
  "准入后查找根换成越界 symlink 时执行前阻止 glob",
  { skip: process.platform === "win32" },
  async () => {
    const workdir = fixtureWorkdir("glob-drift-workdir-");
    const outsideDir = fixtureWorkdir("glob-drift-outside-");
    const admittedDir = join(workdir, "notes");
    mkdirSync(admittedDir);
    writeFileSync(join(admittedDir, "inside.md"), "inside", "utf8");
    writeFileSync(join(outsideDir, "LEAKED_SECRET.md"), "secret", "utf8");
    const approvals: ApprovalRequest[] = [];
    const coordinator = new ToolExecutionCoordinator();
    const tools = buildGlobTool(resolveFileToolsSettings({ workdir }), new ToolRegistry(), {
      policy: new DefaultToolPolicy(),
      requestApproval: (request) => {
        approvals.push(request);
        return Promise.resolve({ approved: true });
      },
      coordinator,
    });
    const globTool = tools.roll__glob;
    assert.ok(globTool?.execute !== undefined);
    const input = { pattern: "*.md", path: "notes" };
    const toolCallId = "glob-admission-drift";
    await coordinator.prepare(toolCallId, "roll__glob", input);
    assert.equal(approvals.length, 0);
    rmSync(admittedDir, { recursive: true });
    symlinkSync(outsideDir, admittedDir, "dir");

    const result = (await globTool.execute(
      input,
      executeOptions({ toolCallId }),
    )) as NormalizedToolResult;

    assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
    assert.match(String(result.display), /安全条件.*变化/u);
    assert.doesNotMatch(String(result.display), /LEAKED_SECRET/u);
    assert.equal(String(result.display).includes(outsideDir), false);
  },
);

test("workdir 外路径 scope=session 批准后第二次查找免弹", async () => {
  const workdir = fixtureWorkdir("glob-gate-");
  const outsideDir = fixtureWorkdir("glob-outside-");
  writeFileSync(join(outsideDir, "secret.md"), "x", "utf8");
  const approvals: ApprovalRequest[] = [];
  const memory = new SessionApprovalMemory();
  const tools = buildGlobFixture(workdir, approvals, true, { scope: "session", memory });
  const globTool = tools.roll__glob;
  assert.ok(globTool?.execute !== undefined);
  const first = (await globTool.execute(
    { pattern: "*.md", path: outsideDir },
    executeOptions({ toolCallId: "t1" }),
  )) as NormalizedToolResult;
  assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  const second = (await globTool.execute(
    { pattern: "*.md", path: outsideDir },
    executeOptions({ toolCallId: "t2" }),
  )) as NormalizedToolResult;
  assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
});
