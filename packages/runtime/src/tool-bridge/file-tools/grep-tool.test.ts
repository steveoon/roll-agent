import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { resolveFileToolsSettings } from "./settings.ts";
import { buildGrepTool, executeGrep } from "./grep-tool.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { SessionApprovalMemory } from "../../approval/approval-memory.ts";
import { TOOL_OUTCOME_KINDS, type NormalizedToolResult } from "../normalize-result.ts";
import { ToolExecutionCoordinator } from "../tool-execution-coordinator.ts";

function fixtureWorkdir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("基本命中格式：按文件分组，绝对路径文件头 + 行号箭头", async () => {
  const workdir = fixtureWorkdir("grep-basic-");
  writeFileSync(join(workdir, "a.ts"), 'function foo() {\n  console.log("hello");\n}\n', "utf8");
  writeFileSync(join(workdir, "b.ts"), "export function foo() {\n  return 1;\n}\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "foo" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.ok(text.includes(join(workdir, "a.ts")));
  assert.ok(text.includes(join(workdir, "b.ts")));
  assert.ok(text.includes("    1→function foo() {"));
  assert.ok(text.includes("    1→export function foo() {"));
  assert.match(text, /共 2 处命中（2 个文件）/u);
});

test("context 行渲染：命中前后附带上下文行", async () => {
  const workdir = fixtureWorkdir("grep-context-");
  writeFileSync(join(workdir, "a.txt"), "alpha\nneedle-hit\ngamma\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "needle", context: 1 });
  const text = String(result.display);
  assert.ok(text.includes("    1→alpha"));
  assert.ok(text.includes("    2→needle-hit"));
  assert.ok(text.includes("    3→gamma"));
});

test("glob 过滤生效：仅命中匹配 glob 的文件", async () => {
  const workdir = fixtureWorkdir("grep-glob-");
  writeFileSync(join(workdir, "a.ts"), "target\n", "utf8");
  writeFileSync(join(workdir, "b.txt"), "target\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "target", glob: "*.ts" });
  const text = String(result.display);
  assert.ok(text.includes(join(workdir, "a.ts")));
  assert.ok(!text.includes(join(workdir, "b.txt")));
});

test("ignore_case 控制大小写敏感匹配", async () => {
  const workdir = fixtureWorkdir("grep-case-");
  writeFileSync(join(workdir, "a.txt"), "TARGET\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const withoutFlag = await executeGrep(settings, { pattern: "target" });
  assert.match(String(withoutFlag.display), /未找到匹配/u);
  const withFlag = await executeGrep(settings, { pattern: "target", ignore_case: true });
  assert.ok(String(withFlag.display).includes("TARGET"));
});

test("0 命中且 pattern 含全角标点时追加归一化提示", async () => {
  const workdir = fixtureWorkdir("grep-normalize-");
  writeFileSync(join(workdir, "a.txt"), "普通内容\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "你好，世界" });
  const text = String(result.display);
  assert.match(text, /^未找到匹配。/u);
  assert.ok(text.includes("试试：你好,世界"));
});

test("0 命中且 pattern 无需归一化时不追加提示", async () => {
  const workdir = fixtureWorkdir("grep-normalize-plain-");
  writeFileSync(join(workdir, "a.txt"), "普通内容\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "zzz_nomatch" });
  assert.equal(String(result.display), "未找到匹配。");
});

test("非法正则返回 tool_failed 且带可读错误信息", async () => {
  const workdir = fixtureWorkdir("grep-badregex-");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "([unclosed" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /regex/iu);
});

test("max_results 截断命中行数并提示", async () => {
  const workdir = fixtureWorkdir("grep-maxresults-");
  writeFileSync(join(workdir, "a.txt"), "hit1\nhit2\nhit3\nhit4\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "hit", max_results: 2 });
  const text = String(result.display);
  assert.ok(text.includes("    1→hit1"));
  assert.ok(text.includes("    2→hit2"));
  assert.ok(!text.includes("hit3"));
  assert.ok(!text.includes("hit4"));
  assert.match(text, /结果过多已截断/u);
});

test("超长命中行内容超过 500 字符时截断", async () => {
  const workdir = fixtureWorkdir("grep-longline-");
  const longLine = `needle-${"x".repeat(600)}`;
  writeFileSync(join(workdir, "a.txt"), `${longLine}\n`, "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "needle" });
  const text = String(result.display);
  assert.ok(text.includes("…"));
  assert.ok(!text.includes(longLine));
});

test("文件名含「分隔符+数字+分隔符」（如日期前缀）时不误判路径与行号", async () => {
  const workdir = fixtureWorkdir("grep-datefile-");
  mkdirSync(join(workdir, "docs"), { recursive: true });
  const filePath = join(workdir, "docs", "2026-08-14-plan.md");
  writeFileSync(filePath, "alpha\nbeta\nneedle-gamma\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "needle" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.ok(text.includes(filePath));
  assert.match(text, /共 1 处命中（1 个文件）/u);
  assert.ok(text.includes("    3→needle-gamma"));
});

test("path 直接指向单个文件时仍能正确解析命中（依赖 --with-filename）", async () => {
  const workdir = fixtureWorkdir("grep-singlefile-");
  const filePath = join(workdir, "a.ts");
  writeFileSync(filePath, 'function foo() {\n  console.log("hello");\n}\n', "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "foo", path: filePath });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.ok(text.includes(filePath));
  assert.ok(text.includes("    1→function foo() {"));
});

test("单文件命中数超过 max_results 时按全局计数截断并提示", async () => {
  const workdir = fixtureWorkdir("grep-percap-over-");
  const content = Array.from({ length: 60 }, (_, index) => `hit-${String(index)}`).join("\n");
  writeFileSync(join(workdir, "a.txt"), `${content}\n`, "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "hit-", max_results: 50 });
  const text = String(result.display);
  const arrowCount = (text.match(/→/gu) ?? []).length;
  assert.equal(arrowCount, 50);
  assert.match(text, /结果过多已截断/u);
});

test("单文件命中数恰好等于 max_results 时不误报截断", async () => {
  const workdir = fixtureWorkdir("grep-percap-exact-");
  const content = Array.from({ length: 50 }, (_, index) => `hit-${String(index)}`).join("\n");
  writeFileSync(join(workdir, "a.txt"), `${content}\n`, "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "hit-", max_results: 50 });
  const text = String(result.display);
  const arrowCount = (text.match(/→/gu) ?? []).length;
  assert.equal(arrowCount, 50);
  assert.doesNotMatch(text, /结果过多已截断/u);
});

test("命中输出超过 settings.maxOutputChars 时按行边界截断并提示", async () => {
  const workdir = fixtureWorkdir("grep-outputcap-");
  const lines = Array.from(
    { length: 200 },
    (_, index) => `hit-line-${String(index).padStart(3, "0")}-${"x".repeat(20)}`,
  ).join("\n");
  writeFileSync(join(workdir, "a.txt"), `${lines}\n`, "utf8");
  const settings = resolveFileToolsSettings({ workdir, maxOutputChars: 500 });
  const result = await executeGrep(settings, { pattern: "hit-line", max_results: 200 });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.ok(text.length < lines.length);
  assert.match(text, /（输出达上限已截断，请缩小范围）/u);
  const resultLines = text.split("\n").filter((line) => line.includes("→"));
  assert.ok(resultLines.length > 0);
  for (const line of resultLines) {
    assert.match(line, /^\s*\d+→hit-line-\d{3}-x{20}$/u);
  }
});

function executeOptions(
  overrides: Partial<ToolExecutionOptions<unknown>> = {},
): ToolExecutionOptions<unknown> {
  return { toolCallId: "call-1", messages: [], context: undefined, ...overrides };
}

function buildGrepFixture(
  workdir: string,
  approvals: ApprovalRequest[],
  approve: boolean,
  options: { readonly scope?: "once" | "session"; readonly memory?: SessionApprovalMemory } = {},
) {
  const registry = new ToolRegistry();
  const settings = resolveFileToolsSettings({ workdir });
  return buildGrepTool(settings, registry, {
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
  const workdir = fixtureWorkdir("grep-gate-");
  const outsideDir = fixtureWorkdir("grep-outside-");
  writeFileSync(join(outsideDir, "secret.txt"), "needle\n", "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildGrepFixture(workdir, approvals, false);
  const grepTool = tools.roll__grep;
  assert.ok(grepTool?.execute !== undefined);
  const result = (await grepTool.execute(
    { pattern: "needle", path: outsideDir },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.userRejected);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.toolName, "grep");
  assert.equal(approvals[0]?.reason, "读取工作目录以外的文件");
});

test("workdir 外路径批准后可正常搜索", async () => {
  const workdir = fixtureWorkdir("grep-gate-");
  const outsideDir = fixtureWorkdir("grep-outside-");
  writeFileSync(join(outsideDir, "secret.txt"), "needle\n", "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildGrepFixture(workdir, approvals, true);
  const grepTool = tools.roll__grep;
  assert.ok(grepTool?.execute !== undefined);
  const result = (await grepTool.execute(
    { pattern: "needle", path: outsideDir },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
});

test("workdir 内路径不触发确认门", async () => {
  const workdir = fixtureWorkdir("grep-gate-");
  writeFileSync(join(workdir, "a.txt"), "needle\n", "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildGrepFixture(workdir, approvals, true);
  const grepTool = tools.roll__grep;
  assert.ok(grepTool?.execute !== undefined);
  const result = (await grepTool.execute(
    { pattern: "needle" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 0);
});

test(
  "准入后搜索根换成越界 symlink 时执行前阻止 grep",
  { skip: process.platform === "win32" },
  async () => {
    const workdir = fixtureWorkdir("grep-drift-workdir-");
    const outsideDir = fixtureWorkdir("grep-drift-outside-");
    const admittedDir = join(workdir, "notes");
    mkdirSync(admittedDir);
    writeFileSync(join(admittedDir, "inside.txt"), "inside\n", "utf8");
    writeFileSync(join(outsideDir, "secret.txt"), "LEAKED_SECRET\n", "utf8");
    const approvals: ApprovalRequest[] = [];
    const coordinator = new ToolExecutionCoordinator();
    const tools = buildGrepTool(resolveFileToolsSettings({ workdir }), new ToolRegistry(), {
      policy: new DefaultToolPolicy(),
      requestApproval: (request) => {
        approvals.push(request);
        return Promise.resolve({ approved: true });
      },
      coordinator,
    });
    const grepTool = tools.roll__grep;
    assert.ok(grepTool?.execute !== undefined);
    const input = { pattern: "LEAKED_SECRET", path: "notes" };
    const toolCallId = "grep-admission-drift";
    await coordinator.prepare(toolCallId, "roll__grep", input);
    assert.equal(approvals.length, 0);
    rmSync(admittedDir, { recursive: true });
    symlinkSync(outsideDir, admittedDir, "dir");

    const result = (await grepTool.execute(
      input,
      executeOptions({ toolCallId }),
    )) as NormalizedToolResult;

    assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
    assert.match(String(result.display), /安全条件.*变化/u);
    assert.doesNotMatch(String(result.display), /LEAKED_SECRET/u);
    assert.equal(String(result.display).includes(outsideDir), false);
  },
);

test("context 越界在审批前以一句话 invalid_input 拒绝", async () => {
  const workdir = fixtureWorkdir("grep-bounded-context-");
  writeFileSync(join(workdir, "a.txt"), "needle\n", "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildGrepFixture(workdir, approvals, true);
  const grepTool = tools.roll__grep;
  assert.ok(grepTool?.execute !== undefined);
  const result = (await grepTool.execute(
    { pattern: "needle", context: 18 },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  const message = String(result.display);
  assert.ok(message.includes("context"));
  assert.ok(message.includes("≤10"));
  assert.ok(message.includes("18"));
  assert.equal(approvals.length, 0);
});

test("max_results 越界同样一句话拒绝", async () => {
  const workdir = fixtureWorkdir("grep-bounded-max-");
  writeFileSync(join(workdir, "a.txt"), "needle\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeGrep(settings, { pattern: "needle", max_results: 0 });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  const message = String(result.display);
  assert.ok(message.includes("max_results"));
  assert.ok(message.includes("≥1"));
});

test("context 描述携带范围，模型第一次调用即知边界", () => {
  const tools = buildGrepTool(
    resolveFileToolsSettings({ workdir: fixtureWorkdir("grep-desc-") }),
    new ToolRegistry(),
    {
      policy: new DefaultToolPolicy(),
      requestApproval: () => Promise.resolve({ approved: true }),
    },
  );
  const schema = (
    tools.roll__grep as {
      inputSchema?: { shape?: Record<string, { description?: string }> };
    }
  ).inputSchema;
  assert.ok((schema?.shape?.context?.description ?? "").includes("范围 0-10"));
  assert.ok((schema?.shape?.max_results?.description ?? "").includes("范围 1-500"));
});

test("workdir 外路径 scope=session 批准后第二次搜索免弹", async () => {
  const workdir = fixtureWorkdir("grep-gate-");
  const outsideDir = fixtureWorkdir("grep-outside-");
  writeFileSync(join(outsideDir, "secret.txt"), "needle\n", "utf8");
  const approvals: ApprovalRequest[] = [];
  const memory = new SessionApprovalMemory();
  const tools = buildGrepFixture(workdir, approvals, true, { scope: "session", memory });
  const grepTool = tools.roll__grep;
  assert.ok(grepTool?.execute !== undefined);
  const first = (await grepTool.execute(
    { pattern: "needle", path: outsideDir },
    executeOptions({ toolCallId: "t1" }),
  )) as NormalizedToolResult;
  assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  const second = (await grepTool.execute(
    { pattern: "needle", path: outsideDir },
    executeOptions({ toolCallId: "t2" }),
  )) as NormalizedToolResult;
  assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
});
