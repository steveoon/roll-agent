import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { checkAgentHealth } from "../../registry/health-check.ts";
import { log } from "../utils/output.ts";

export default defineCommand({
  meta: { description: "检查 Agent 健康状态" },
  args: {
    restart: {
      type: "boolean",
      description: "自动重启异常退出的 Agent",
      default: false,
    },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);

    const results = checkAgentHealth(store, config.agents.dataDir, {
      autoRestart: args.restart,
    });

    if (results.length === 0) {
      log.info("没有需要检查的在线 Agent。");
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    for (const result of results) {
      if (result.healthy) {
        const suffix = result.restarted ? "（已重启）" : "";
        log.success(`${result.agentName}: ${result.message}${suffix}`);
      } else {
        log.error(`${result.agentName}: ${result.message}`);
      }
    }

    const unhealthy = results.filter((r) => !r.healthy);
    if (unhealthy.length > 0) {
      process.exitCode = 1;
    }
  },
});
