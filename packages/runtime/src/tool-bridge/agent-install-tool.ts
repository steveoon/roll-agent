import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolBridgeContext } from "./build-tools.ts";
import type { ToolRegistry } from "./naming.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";

export const AGENT_INSTALL_TOOL_AGENT_NAME = "roll";
export const AGENT_INSTALL_TOOL_NAME = "agent_install";
export const AGENT_INSTALL_TOOL_ID = `${AGENT_INSTALL_TOOL_AGENT_NAME}__${AGENT_INSTALL_TOOL_NAME}`;

export interface AgentInstallToolCatalogEntry {
  readonly shortName: string;
  readonly description: string;
}

export type AgentInstallToolOutcome =
  | {
      readonly ok: true;
      readonly agentName: string;
      readonly version?: string;
      readonly missingEnv: readonly string[];
      readonly retryCommand?: string;
      readonly refreshApplied: boolean;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly retryCommand?: string;
    };

export interface AgentInstallToolDeps {
  readonly catalog: readonly AgentInstallToolCatalogEntry[];
  readonly install: (
    shortName: string,
    report: (line: string) => void,
  ) => Promise<AgentInstallToolOutcome>;
}

function renderOutcome(outcome: AgentInstallToolOutcome, logLines: readonly string[]): NormalizedToolResult {
  const logSection = logLines.length > 0 ? `\n\n安装日志：\n${logLines.join("\n")}` : "";
  if (!outcome.ok) {
    const retryNote = outcome.retryCommand ? `\n可在终端重试：${outcome.retryCommand}` : "";
    return { output: `安装失败：${outcome.message}${retryNote}${logSection}`, isError: true };
  }

  const versionNote = outcome.version ? ` v${outcome.version}` : "";
  const availabilityNote = outcome.refreshApplied
    ? "新工具将从下一轮对话开始可用。"
    : "当前会话不会自动接入本次安装的版本，请让用户重新运行 roll chat 后使用。";
  const envNote =
    outcome.missingEnv.length > 0
      ? `\n缺少必填环境变量：${outcome.missingEnv.join(", ")}。请让用户在终端运行 \`roll config setup agent ${outcome.agentName}\` 完成配置。`
      : "";
  const retryNote = outcome.retryCommand
    ? `\n浏览器运行时已跳过安装，请让用户在终端补跑：${outcome.retryCommand}`
    : "";
  return {
    output: `已安装并注册 Agent "${outcome.agentName}"${versionNote}。${availabilityNote}${envNote}${retryNote}${logSection}`,
    isError: false,
  };
}

export function buildAgentInstallToolset(
  deps: AgentInstallToolDeps,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const shortNames = deps.catalog.map((entry) => entry.shortName);
  const [firstShortName, ...restShortNames] = shortNames;
  if (firstShortName === undefined) {
    return {};
  }

  const id = registry.register(AGENT_INSTALL_TOOL_AGENT_NAME, AGENT_INSTALL_TOOL_NAME);
  const inputSchema = z.object({
    agent: z
      .enum([firstShortName, ...restShortNames])
      .describe(`要安装的官方 Agent 短名（可选：${shortNames.join("、")}）`),
  });

  return {
    [id]: tool({
      description: `安装并注册一个官方子 Agent（执行 npm install，需要用户确认，可能耗时较长）。可安装：${deps.catalog
        .map((entry) => `${entry.shortName}（${entry.description}）`)
        .join("；")}`,
      inputSchema,
      execute: async (input): Promise<NormalizedToolResult> => {
        const decision = ctx.policy?.check({
          agentName: AGENT_INSTALL_TOOL_AGENT_NAME,
          toolName: AGENT_INSTALL_TOOL_NAME,
          input,
          annotations: { destructiveHint: true },
        });
        if (decision?.action === "deny") {
          return {
            output: `策略拒绝执行${decision.reason ? `: ${decision.reason}` : ""}`,
            isError: true,
          };
        }

        const approval = await ctx.requestApproval({
          agentName: AGENT_INSTALL_TOOL_AGENT_NAME,
          toolName: AGENT_INSTALL_TOOL_NAME,
          input,
          reason: `将执行 npm install 并注册子 Agent "${input.agent}"`,
        });
        if (!approval.approved) {
          return {
            output: `已取消执行${approval.reason ? `: ${approval.reason}` : ""}`,
            isError: true,
          };
        }

        const logLines: string[] = [];
        const outcome = await deps.install(input.agent, (line) => logLines.push(line));
        return renderOutcome(outcome, logLines);
      },
    }),
  };
}
