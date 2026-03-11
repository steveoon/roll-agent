import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { loadConfig } from "../../config/loader.ts";
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

export default defineCommand({
  meta: { description: "诊断系统状态" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  run({ args }) {
    const checks: CheckResult[] = [];

    // 1. Node.js 版本
    const nodeVersion = process.versions.node;
    const [major] = nodeVersion.split(".").map(Number);
    checks.push(
      major !== undefined && major >= 22
        ? { name: "Node.js 版本", status: "ok", message: `v${nodeVersion}` }
        : { name: "Node.js 版本", status: "fail", message: `v${nodeVersion} (需要 ≥22.6.0)` },
    );

    // 2. 配置文件
    let configOk = false;
    try {
      const { configPath } = loadConfig();
      if (configPath) {
        checks.push({ name: "配置文件", status: "ok", message: configPath });
        configOk = true;
      } else {
        checks.push({ name: "配置文件", status: "warn", message: "未找到，使用默认配置" });
        configOk = true;
      }
    } catch (err) {
      checks.push({
        name: "配置文件",
        status: "fail",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. LLM Provider 配置
    if (configOk) {
      const { config } = loadConfig();
      const providers = Object.keys(config.llm.providers);
      if (providers.length > 0) {
        // 检查 API key 是否像是未解析的环境变量
        const unresolved = providers.filter((p) => {
          const key = config.llm.providers[p]?.apiKey ?? "";
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

      // 4. Agent 数据目录
      const dataDir = config.agents.dataDir;
      checks.push(
        existsSync(dataDir)
          ? { name: "Agent 数据目录", status: "ok", message: dataDir }
          : { name: "Agent 数据目录", status: "warn", message: `${dataDir} (不存在，首次 add 时创建)` },
      );

      // 5. 已注册 Agent
      const store = new AgentStore(config.agents.dataDir);
      const agents = store.list();
      checks.push({
        name: "已注册 Agent",
        status: agents.length > 0 ? "ok" : "warn",
        message: agents.length > 0
          ? `${String(agents.length)} 个 (${agents.map((a) => a.skill.name).join(", ")})`
          : "无",
      });
    }

    // 输出
    if (args.json) {
      console.log(JSON.stringify(checks, null, 2));
      return;
    }

    console.log("Roll Agent 系统诊断\n");
    for (const check of checks) {
      const icon = STATUS_ICONS[check.status];
      console.log(`  ${icon} ${check.name}: ${check.message}`);
    }

    const hasFailure = checks.some((c) => c.status === "fail");
    console.log(hasFailure ? "\n存在问题，请修复后重试。" : "\n系统状态正常。");

    if (hasFailure) {
      process.exitCode = 1;
    }
  },
});
