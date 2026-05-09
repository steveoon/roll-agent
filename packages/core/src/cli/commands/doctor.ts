import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { getAgentEnvFromAgentsConfig, inspectAgentEnvRequirements } from "../../config/helpers.ts";
import { inspectConfigFile, loadAgentsConfig, loadConfig } from "../../config/loader.ts";
import {
  inspectAgentRuntimeEnvRequirements,
  summarizeAgentRuntimeEnvReport,
} from "../../config/runtime-env.ts";
import { inspectAgentRuntimeEnv } from "../../mcp/agent-diagnostics.ts";
import { AgentStore } from "../../registry/store.ts";

interface CheckResult {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly message: string;
}

const STATUS_ICONS: Record<CheckResult["status"], string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

const MIN_NODE_VERSION = { major: 22, minor: 6, patch: 0 } as const;

export function isNodeVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (major > MIN_NODE_VERSION.major) return true;
  if (major < MIN_NODE_VERSION.major) return false;

  if (minor > MIN_NODE_VERSION.minor) return true;
  if (minor < MIN_NODE_VERSION.minor) return false;

  return patch >= MIN_NODE_VERSION.patch;
}

export default defineCommand({
  meta: { description: "诊断 Roll 配置、Agent 注册表和运行时状态" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    const checks: CheckResult[] = [];
    let effectiveConfig: ReturnType<typeof loadConfig>["config"] | undefined;

    // 1. Node.js 版本
    const nodeVersion = process.versions.node;
    checks.push(
      isNodeVersionSupported(nodeVersion)
        ? { name: "Node.js 版本", status: "ok", message: `v${nodeVersion}` }
        : { name: "Node.js 版本", status: "fail", message: `v${nodeVersion} (需要 ≥22.6.0)` },
    );

    // 2. 配置文件（只加载一次，后续复用）
    const configInspection = inspectConfigFile();
    let fullConfig: ReturnType<typeof loadAgentsConfig>["agentsConfig"] | undefined;

    switch (configInspection.status) {
      case "not-found":
        checks.push({ name: "配置文件", status: "warn", message: "未找到，使用默认配置" });
        effectiveConfig = loadConfig().config;
        break;
      case "valid":
        checks.push({ name: "配置文件", status: "ok", message: configInspection.configPath });
        effectiveConfig = configInspection.config;
        break;
      case "needs-migration":
        checks.push({
          name: "配置文件",
          status: "warn",
          message: `${configInspection.configPath} (需要迁移，运行 roll config migrate)`,
        });
        break;
      case "invalid":
        checks.push({
          name: "配置文件",
          status: "fail",
          message: configInspection.error.message,
        });
        break;
    }

    try {
      fullConfig = loadAgentsConfig().agentsConfig;
    } catch (err) {
      checks.push({
        name: "Agent 配置",
        status: "fail",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. LLM Provider 配置
    if (effectiveConfig) {
      const providers = Object.keys(effectiveConfig.llm.providers);
      if (providers.length > 0) {
        // 检查 API key 是否像是未解析的环境变量
        const unresolved = providers.filter((p) => {
          const key = effectiveConfig.llm.providers[p]?.apiKey ?? "";
          return key.startsWith("${") || key.length === 0;
        });
        if (unresolved.length > 0) {
          checks.push({
            name: "LLM Providers",
            status: "warn",
            message: `${providers.join(", ")} (${unresolved.join(", ")} API key 未设置)`,
          });
        } else {
          checks.push({
            name: "LLM Providers",
            status: "ok",
            message: providers.join(", "),
          });
        }
      } else {
        checks.push({
          name: "LLM Providers",
          status: "warn",
          message: "未配置任何 provider",
        });
      }
    } else if (configInspection.status === "needs-migration") {
      checks.push(
        {
          name: "LLM Providers",
          status: "warn",
          message: "配置需要迁移，跳过完整 LLM 配置校验",
        },
      );
    }

    if (fullConfig) {
      // 4. Agent 数据目录
      const dataDir = fullConfig.dataDir;
      checks.push(
        existsSync(dataDir)
          ? { name: "Agent 数据目录", status: "ok", message: dataDir }
          : {
              name: "Agent 数据目录",
              status: "warn",
              message: `${dataDir} (不存在，首次 add 时创建)`,
            },
      );

      // 5. 已注册 Agent
      const store = new AgentStore(fullConfig.dataDir);
      const agents = store.list();
      checks.push({
        name: "已注册 Agent",
        status: agents.length > 0 ? "ok" : "warn",
        message:
          agents.length > 0
            ? `${String(agents.length)} 个 (${agents.map((a) => a.skill.name).join(", ")})`
            : "无",
      });

      for (const agent of agents) {
        const envReport = inspectAgentEnvRequirements(
          agent.skill.name,
          agent.skill.env,
          fullConfig.env,
        );
        if (!envReport) {
          continue;
        }

        const runtimeInspection = await inspectAgentRuntimeEnv(agent, { agentsConfig: fullConfig });
        const runtimeReport = inspectAgentRuntimeEnvRequirements(
          envReport,
          getAgentEnvFromAgentsConfig(fullConfig, agent.skill.name),
          runtimeInspection,
        );
        const summary = summarizeAgentRuntimeEnvReport(runtimeReport);
        checks.push({
          name: `Agent 环境变量 (${agent.skill.name})`,
          status: summary.status,
          message: summary.message,
        });
      }
    }

    const hasFailure = checks.some((c) => c.status === "fail");

    // 输出
    if (args.json) {
      console.log(JSON.stringify(checks, null, 2));
      if (hasFailure) {
        process.exitCode = 1;
      }
      return;
    }

    console.log("Roll Agent 系统诊断\n");
    for (const check of checks) {
      const icon = STATUS_ICONS[check.status];
      console.log(`  ${icon} ${check.name}: ${check.message}`);
    }

    console.log(hasFailure ? "\n存在问题，请修复后重试。" : "\n系统状态正常。");

    if (hasFailure) {
      process.exitCode = 1;
    }
  },
});
