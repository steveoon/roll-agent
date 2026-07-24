import { defineCommand } from "citty";
import { existsSync, rmSync } from "node:fs";
import { loadAgentsConfig } from "../../config/loader.ts";
import { acquireAgentRegistryLockAsync } from "../../registry/agent-registry-lock.ts";
import { acquireAgentUsageMaintenanceGuard } from "../../registry/agent-usage-lease.ts";
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
    let registryLock: Awaited<ReturnType<typeof acquireAgentRegistryLockAsync>>;
    try {
      registryLock = await acquireAgentRegistryLockAsync(agentsConfig.dataDir);
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    const store = new AgentStore(agentsConfig.dataDir, { registryLock });

    let maintenanceGuard: Awaited<ReturnType<typeof acquireAgentUsageMaintenanceGuard>> | undefined;
    try {
      const agent = store.findByName(args.name);
      if (!agent) {
        log.error(`Agent "${args.name}" 未找到`);
        process.exitCode = 1;
        return;
      }

      if (agent.runtime.ownership === "core-managed") {
        maintenanceGuard = await acquireAgentUsageMaintenanceGuard(agent, agentsConfig.dataDir);
        await stopAgentGracefully(agentsConfig.dataDir, agent.skill.name, {
          ...(maintenanceGuard
            ? {
                lifecycleLock: maintenanceGuard.lifecycleLock,
                ...(maintenanceGuard.runtime
                  ? { expectedIdentity: maintenanceGuard.runtime.identity }
                  : {}),
              }
            : {}),
        });
      }

      const sourceType = inferAgentSourceType(agent);
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

      const removed = store.remove(args.name);
      if (!removed) {
        throw new Error(`Agent "${args.name}" 未找到`);
      }

      log.success(`Agent "${args.name}" 已移除`);
    } catch (err) {
      log.error(`移除 ${args.name} 失败：${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      maintenanceGuard?.release();
      registryLock.release();
    }
  },
});
