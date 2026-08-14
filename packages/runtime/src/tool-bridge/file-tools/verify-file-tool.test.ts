import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { resolveFileToolsSettings } from "./settings.ts";
import {
  VERIFY_FILE_TOOL_NAME,
  buildVerifyFileTool,
  executeVerifyFile,
  renderVerifyReport,
} from "./verify-file-tool.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import { SessionApprovalMemory } from "../../approval/approval-memory.ts";
import { TOOL_OUTCOME_KINDS, type NormalizedToolResult } from "../normalize-result.ts";
import type { VerifierOutcome } from "./verifier-registry.ts";

function fixtureWorkdir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("合法 JSON：pass 且总结为验证通过", async () => {
  const workdir = fixtureWorkdir("verify-json-ok-");
  const filePath = join(workdir, "a.json");
  writeFileSync(filePath, '{"a":1}', "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeVerifyFile(settings, { path: "a.json" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(String(result.display), `验证 ${filePath}：\n✓ json 通过\n\n验证通过（json）`);
});

test("非法 JSON：fail 且总结为验证发现问题，工具结果如实标记为失败", async () => {
  const workdir = fixtureWorkdir("verify-json-bad-");
  const filePath = join(workdir, "a.json");
  writeFileSync(filePath, "{not valid json", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeVerifyFile(settings, { path: "a.json" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  const text = String(result.display);
  assert.match(text, /^验证 .+：\n✗ json 失败：\n {2}.+/u);
  assert.match(text, /验证发现问题，请修复后重试$/u);
});

test("文件不存在返回 invalid_input", async () => {
  const workdir = fixtureWorkdir("verify-missing-");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeVerifyFile(settings, { path: "no-such-file.json" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.equal(String(result.display), `文件不存在: ${join(workdir, "no-such-file.json")}`);
});

test("未注册扩展名（.xyz）无候选验证器：全部跳过文案，不做任何验证", async () => {
  const workdir = fixtureWorkdir("verify-unknown-ext-");
  const filePath = join(workdir, "a.xyz");
  writeFileSync(filePath, "content", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeVerifyFile(settings, { path: "a.xyz" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(
    String(result.display),
    `验证 ${filePath}：\n\n该文件类型当前无可用验证器（未安装或未配置），本次未做任何验证`,
  );
});

test(".rs 文件在 project 级下因缺少 Cargo.toml 被 detect 判定跳过：全部跳过文案", async () => {
  const workdir = fixtureWorkdir("verify-rs-nocargo-");
  const filePath = join(workdir, "main.rs");
  writeFileSync(filePath, "fn main() {}\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeVerifyFile(settings, { path: "main.rs", level: "project" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.ok(text.includes("– cargo-check 跳过（未安装或未配置 cargo-check）"));
  assert.match(text, /该文件类型当前无可用验证器（未安装或未配置），本次未做任何验证$/u);
});

test("level=fast 时 .ts 文件展示 detect 未过的 fast 验证器与 project 候选提示行", async () => {
  const workdir = fixtureWorkdir("verify-ts-fast-");
  const filePath = join(workdir, "a.ts");
  writeFileSync(filePath, "export const a = 1;\n", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = await executeVerifyFile(settings, { path: "a.ts" });
  const text = String(result.display);
  assert.ok(text.includes("– eslint 跳过（未安装或未配置 eslint）"));
  assert.ok(text.includes('– tsc 跳过（level=fast 未包含，用 level: "project" 运行）'));
  assert.match(text, /该文件类型当前无可用验证器（未安装或未配置），本次未做任何验证$/u);
});

test("renderVerifyReport：至少一个 fail 时总结为验证发现问题", () => {
  const outcomes: VerifierOutcome[] = [
    { id: "eslint", status: "pass" },
    { id: "ruff", status: "fail", output: "line1\nline2" },
  ];
  const text = renderVerifyReport("/abs/path.ts", outcomes, []);
  assert.equal(
    text,
    "验证 /abs/path.ts：\n✓ eslint 通过\n✗ ruff 失败：\n  line1\n  line2\n\n验证发现问题，请修复后重试",
  );
});

test("renderVerifyReport：全部 skipped（含空数组的真空情形）总结为无可用验证器", () => {
  assert.equal(
    renderVerifyReport("/abs/path.xyz", [], []),
    "验证 /abs/path.xyz：\n\n该文件类型当前无可用验证器（未安装或未配置），本次未做任何验证",
  );
  const outcomes: VerifierOutcome[] = [
    { id: "cargo-check", status: "skipped", reason: "未安装或未配置 cargo-check" },
  ];
  assert.equal(
    renderVerifyReport("/abs/path.rs", outcomes, []),
    "验证 /abs/path.rs：\n– cargo-check 跳过（未安装或未配置 cargo-check）\n\n该文件类型当前无可用验证器（未安装或未配置），本次未做任何验证",
  );
});

test("renderVerifyReport：无 fail 时总结仅列出通过的 id，跳过的 id 不计入", () => {
  const outcomes: VerifierOutcome[] = [
    { id: "eslint", status: "pass" },
    { id: "ruff", status: "skipped", reason: "未安装或未配置 ruff" },
  ];
  const text = renderVerifyReport("/abs/path.ts", outcomes, []);
  assert.ok(text.endsWith("验证通过（eslint）"));
});

test("renderVerifyReport：project 候选在 fast 级别追加提示行", () => {
  const text = renderVerifyReport("/abs/a.ts", [], ["tsc"]);
  assert.equal(
    text,
    '验证 /abs/a.ts：\n– tsc 跳过（level=fast 未包含，用 level: "project" 运行）\n\n该文件类型当前无可用验证器（未安装或未配置），本次未做任何验证',
  );
});

function executeOptions(
  overrides: Partial<ToolExecutionOptions<unknown>> = {},
): ToolExecutionOptions<unknown> {
  return { toolCallId: "call-1", messages: [], context: undefined, ...overrides };
}

function buildVerifyFixture(
  workdir: string,
  approvals: ApprovalRequest[],
  approve: boolean,
  options: { readonly scope?: "once" | "session"; readonly memory?: SessionApprovalMemory } = {},
) {
  const registry = new ToolRegistry();
  const settings = resolveFileToolsSettings({ workdir });
  return buildVerifyFileTool(settings, registry, {
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

test("VERIFY_FILE_TOOL_NAME 为 verify_file", () => {
  assert.equal(VERIFY_FILE_TOOL_NAME, "verify_file");
});

test("level 缺省（fast）不触发确认门", async () => {
  const workdir = fixtureWorkdir("verify-gate-fast-");
  writeFileSync(join(workdir, "a.json"), '{"a":1}', "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildVerifyFixture(workdir, approvals, true);
  const verifyTool = tools.roll__verify_file;
  assert.ok(verifyTool?.execute !== undefined);
  const result = (await verifyTool.execute(
    { path: "a.json" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 0);
});

test("level: project 触发确认门，explanation 含项目级验证与文件名", async () => {
  const workdir = fixtureWorkdir("verify-gate-project-");
  writeFileSync(join(workdir, "a.json"), '{"a":1}', "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildVerifyFixture(workdir, approvals, true);
  const verifyTool = tools.roll__verify_file;
  assert.ok(verifyTool?.execute !== undefined);
  const result = (await verifyTool.execute(
    { path: "a.json", level: "project" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.toolName, "verify_file");
  assert.ok(approvals[0]?.explanation?.includes("项目级验证 a.json"));
  assert.ok(approvals[0]?.explanation?.includes("将执行"));
});

test("level: project 即使 scope=session 批准，也不写入批准记忆——每次都重新确认", async () => {
  const workdir = fixtureWorkdir("verify-gate-project-memory-");
  writeFileSync(join(workdir, "a.json"), '{"a":1}', "utf8");
  const approvals: ApprovalRequest[] = [];
  const memory = new SessionApprovalMemory();
  const tools = buildVerifyFixture(workdir, approvals, true, { scope: "session", memory });
  const verifyTool = tools.roll__verify_file;
  assert.ok(verifyTool?.execute !== undefined);
  const first = (await verifyTool.execute(
    { path: "a.json", level: "project" },
    executeOptions({ toolCallId: "t1" }),
  )) as NormalizedToolResult;
  assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 1);
  const second = (await verifyTool.execute(
    { path: "a.json", level: "project" },
    executeOptions({ toolCallId: "t2" }),
  )) as NormalizedToolResult;
  assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(approvals.length, 2);
});

test("level: project 被拒绝时返回 user_rejected", async () => {
  const workdir = fixtureWorkdir("verify-gate-project-reject-");
  writeFileSync(join(workdir, "a.json"), '{"a":1}', "utf8");
  const approvals: ApprovalRequest[] = [];
  const tools = buildVerifyFixture(workdir, approvals, false);
  const verifyTool = tools.roll__verify_file;
  assert.ok(verifyTool?.execute !== undefined);
  const result = (await verifyTool.execute(
    { path: "a.json", level: "project" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.userRejected);
  assert.equal(approvals.length, 1);
});

test("参数校验失败返回 invalid_input", async () => {
  const workdir = fixtureWorkdir("verify-badinput-");
  const approvals: ApprovalRequest[] = [];
  const tools = buildVerifyFixture(workdir, approvals, true);
  const verifyTool = tools.roll__verify_file;
  assert.ok(verifyTool?.execute !== undefined);
  const result = (await verifyTool.execute({ path: "" }, executeOptions())) as NormalizedToolResult;
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.equal(approvals.length, 0);
});
