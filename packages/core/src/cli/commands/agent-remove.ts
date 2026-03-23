import { defineCommand } from "citty";
import { existsSync, rmSync } from "node:fs";
import { loadAgentsConfig } from "../../config/loader.ts";
import { inferAgentSourceType } from "../../registry/source.ts";
import { stopAgentGracefully } from "../../registry/process-manager.ts";
import { AgentStore } from "../../registry/store.ts";
import { log } from "../utils/output.ts";

export default defineCommand({
  meta: { description: "移除一个 Agent" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const store = new AgentStore(agentsConfig.dataDir);
    const agent = store.findByName(args.name);

    if (!agent) {
      log.error(`Agent "${args.name}" 未找到`);
      process.exitCode = 1;
      return;
    }

    if (agent.runtime.ownership === "core-managed") {
      try {
        await stopAgentGracefully(agentsConfig.dataDir, agent.skill.name);
      } catch (err) {
        log.error(`停止 ${args.name} 失败：${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    }

    const sourceType = inferAgentSourceType(agent);
    try {
      switch (sourceType) {
        case "installed-package":
          if (agent.source?.type === "installed-package" && existsSync(agent.source.installDir)) {
            rmSync(agent.source.installDir, { recursive: true, force: true });
          }
          break;
        case "remote-manifest":
          if (existsSync(agent.installPath)) {
            rmSync(agent.installPath, { recursive: true, force: true });
          }
          break;
        case "git":
        case "local-path":
          break;
      }
    } catch (err) {
      log.error(`移除 ${args.name} 失败：${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    const removed = store.remove(args.name);
    if (!removed) {
      log.error(`Agent "${args.name}" 未找到`);
      process.exitCode = 1;
      return;
    }

    log.success(`Agent "${args.name}" 已移除`);
  },
});
