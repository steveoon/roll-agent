import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecutionOptions } from "ai";
import { AGENT_INSTALL_TOOL_ID, buildAgentInstallToolset } from "./agent-install-tool.ts";
import { ToolRegistry } from "./naming.ts";
import type { AgentInstallToolDeps, AgentInstallToolOutcome } from "./agent-install-tool.ts";
import type { ToolBridgeContext } from "./build-tools.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";
import type { PolicyDecision, ToolPolicy } from "../types/policy.ts";

const EXEC_OPTIONS = { toolCallId: "t1", messages: [] } as unknown as ToolExecutionOptions<unknown>;

function fixedPolicy(decision: PolicyDecision): ToolPolicy {
  return { check: () => decision };
}

interface Harness {
  readonly deps: AgentInstallToolDeps;
  readonly installCalls: string[];
  readonly approvalRequests: string[];
}

function makeHarness(options: {
  readonly outcome?: AgentInstallToolOutcome;
  readonly approve?: boolean;
  readonly policy?: ToolPolicy;
}): Harness & { readonly execute: (agent: string) => Promise<NormalizedToolResult> } {
  const installCalls: string[] = [];
  const approvalRequests: string[] = [];
  const deps: AgentInstallToolDeps = {
    catalog: [
      { shortName: "browser-use", description: "浏览器操控" },
      { shortName: "smart-reply", description: "智能回复" },
    ],
    install: async (shortName, report) => {
      installCalls.push(shortName);
      report("安装中...");
      return (
        options.outcome ?? {
          ok: true,
          agentName: `${shortName}-agent`,
          version: "1.0.0",
          missingEnv: [],
          refreshApplied: true,
        }
      );
    },
  };
  const ctx: ToolBridgeContext = {
    ...(options.policy ? { policy: options.policy } : {}),
    requestApproval: async (request) => {
      approvalRequests.push(request.toolName);
      return options.approve === false
        ? { approved: false, reason: "用户取消" }
        : { approved: true };
    },
  };
  const toolset = buildAgentInstallToolset(deps, new ToolRegistry(), ctx);
  const installTool = toolset[AGENT_INSTALL_TOOL_ID];
  if (!installTool?.execute) {
    throw new Error("agent_install 工具未注册");
  }
  const execute = async (agent: string): Promise<NormalizedToolResult> =>
    (await installTool.execute?.({ agent }, EXEC_OPTIONS)) as NormalizedToolResult;
  return { deps, installCalls, approvalRequests, execute };
}

test("catalog 为空时不注册工具", () => {
  const toolset = buildAgentInstallToolset(
    { catalog: [], install: async () => ({ ok: false, message: "n/a" }) },
    new ToolRegistry(),
    { requestApproval: async () => ({ approved: true }) },
  );
  assert.deepEqual(Object.keys(toolset), []);
});

test("policy deny 时直接拒绝，不请求确认也不安装", async () => {
  const harness = makeHarness({ policy: fixedPolicy({ action: "deny", reason: "禁止安装" }) });
  const result = await harness.execute("browser-use");
  assert.equal(result.isError, true);
  assert.match(String(result.output), /策略拒绝执行/);
  assert.equal(harness.approvalRequests.length, 0);
  assert.equal(harness.installCalls.length, 0);
});

test("policy allow 仍然强制请求用户确认", async () => {
  const harness = makeHarness({ policy: fixedPolicy({ action: "allow" }), approve: true });
  const result = await harness.execute("smart-reply");
  assert.equal(result.isError, false);
  assert.deepEqual(harness.approvalRequests, ["agent_install"]);
  assert.deepEqual(harness.installCalls, ["smart-reply"]);
});

test("用户拒绝确认时取消执行且不安装", async () => {
  const harness = makeHarness({ approve: false });
  const result = await harness.execute("browser-use");
  assert.equal(result.isError, true);
  assert.match(String(result.output), /已取消执行/);
  assert.equal(harness.installCalls.length, 0);
});

test("安装成功输出注册名、版本与下一轮可用提示", async () => {
  const harness = makeHarness({});
  const result = await harness.execute("browser-use");
  assert.equal(result.isError, false);
  const output = String(result.output);
  assert.match(output, /browser-use-agent/);
  assert.match(output, /v1\.0\.0/);
  assert.match(output, /下一轮对话开始可用/);
  assert.match(output, /安装日志/);
});

test("成功但未热刷新时提示重开会话；缺 env 与补装命令透传", async () => {
  const harness = makeHarness({
    outcome: {
      ok: true,
      agentName: "browser-use-agent",
      missingEnv: ["REPLY_AUTHORITY_URL"],
      retryCommand: "roll agent install browser-use",
      refreshApplied: false,
    },
  });
  const result = await harness.execute("browser-use");
  const output = String(result.output);
  assert.match(output, /重新运行 roll chat/);
  assert.match(output, /REPLY_AUTHORITY_URL/);
  assert.match(output, /roll agent install browser-use/);
});

test("安装失败输出错误与重试命令", async () => {
  const harness = makeHarness({
    outcome: { ok: false, message: "npm 网络失败", retryCommand: "roll agent install browser-use" },
  });
  const result = await harness.execute("browser-use");
  assert.equal(result.isError, true);
  const output = String(result.output);
  assert.match(output, /安装失败：npm 网络失败/);
  assert.match(output, /可在终端重试/);
});
