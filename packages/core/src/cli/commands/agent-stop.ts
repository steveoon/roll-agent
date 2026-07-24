import { defineCommand } from "citty";
import { loadAgentsConfig } from "../../config/loader.ts";
import { acquireAgentUsageMaintenanceGuard } from "../../registry/agent-usage-lease.ts";
import { acquireAgentRegistryLockAsync } from "../../registry/agent-registry-lock.ts";
import { stopAgentGracefully } from "../../registry/process-manager.ts";
import { AgentStore } from "../../registry/store.ts";
import { log } from "../utils/output.ts";

export default defineCommand({
  meta: { description: "停止由 Roll 托管的 core-managed Agent" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const registryLock = await acquireAgentRegistryLockAsync(agentsConfig.dataDir);
    try {
      const store = new AgentStore(agentsConfig.dataDir, { registryLock });
      const agent = store.findByName(args.name);

      if (!agent) {
        log.error(`Agent "${args.name}" 未找到`);
        process.exitCode = 1;
        return;
      }

      switch (agent.runtime.ownership) {
        case "on-demand":
          log.success(`Agent "${args.name}" 为按需模式，无需手动停止。`);
          return;
        case "external-managed":
          log.info(`Agent "${args.name}" 由外部服务管理，请在外部停止。`);
          if (agent.transport.type === "streamable-http") {
            log.info(`端点: ${agent.transport.endpoint}`);
          }
          return;
        case "core-managed":
          break;
      }

      let stopped = false;
      let maintenanceGuard:
        | Awaited<ReturnType<typeof acquireAgentUsageMaintenanceGuard>>
        | undefined;
      try {
        if (process.platform === "win32") {
          log.info("Windows 下停止为强制终止（无优雅退出信号），Agent 不会执行清理逻辑");
        }
        maintenanceGuard = await acquireAgentUsageMaintenanceGuard(agent, agentsConfig.dataDir);
        stopped = await stopAgentGracefully(agentsConfig.dataDir, agent.skill.name, {
          ...(maintenanceGuard
            ? {
                lifecycleLock: maintenanceGuard.lifecycleLock,
                ...(maintenanceGuard.runtime
                  ? { expectedIdentity: maintenanceGuard.runtime.identity }
                  : {}),
              }
            : {}),
        });
      } catch (err) {
        log.error(
          `停止 Agent "${args.name}" 失败：${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
        return;
      } finally {
        maintenanceGuard?.release();
      }

      store.updateStatus(agent.skill.name, "stopped");

      if (stopped) {
        log.success(`Agent "${args.name}" 已停止`);
        return;
      }

      log.info(`Agent "${args.name}" 当前未运行`);
    } finally {
      registryLock.release();
    }
  },
});
