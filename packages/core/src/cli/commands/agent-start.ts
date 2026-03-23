import { defineCommand } from "citty";
import { loadAgentsConfig } from "../../config/loader.ts";
import {
  getAgentLogPath,
  getAgentPid,
  probeAgentEndpoint,
  startAgent,
  stopAgentGracefully,
  waitForAgentReady,
} from "../../registry/process-manager.ts";
import { AgentStore } from "../../registry/store.ts";
import { log } from "../utils/output.ts";

export default defineCommand({
  meta: { description: "启动 Agent（core-managed HTTP 可由 Roll 托管）" },
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

    switch (agent.runtime.ownership) {
      case "on-demand":
        log.success(`Agent "${args.name}" 为按需模式，无需手动启动。`);
        return;
      case "external-managed":
        log.info(`Agent "${args.name}" 由外部服务管理，Roll 不负责启动。`);
        if (agent.transport.type === "streamable-http") {
          log.info(`端点: ${agent.transport.endpoint}`);
        }
        return;
      case "core-managed":
        break;
    }

    const existingPid = getAgentPid(agentsConfig.dataDir, agent.skill.name);
    if (existingPid !== undefined) {
      try {
        await probeAgentEndpoint(agent, { timeoutMs: 3_000 });
        store.updateStatus(agent.skill.name, "online");
        log.success(
          `Agent "${args.name}" 已在运行 (PID: ${String(existingPid)})` +
            `\n  端点: ${agent.transport.type === "streamable-http" ? agent.transport.endpoint : "n/a"}`,
        );
        return;
      } catch (err) {
        store.updateStatus(agent.skill.name, "error");
        log.error(
          `Agent "${args.name}" 进程存在但不可连接：${err instanceof Error ? err.message : String(err)}`,
        );
        log.info(`日志: ${getAgentLogPath(agentsConfig.dataDir, agent.skill.name)}`);
        process.exitCode = 1;
        return;
      }
    }

    store.updateStatus(agent.skill.name, "starting");
    let pid: number | undefined;
    try {
      pid = startAgent(agent, agentsConfig.dataDir);
      await waitForAgentReady(agent, { startupTimeoutMs: 15_000, probeTimeoutMs: 2_000 });
      store.updateStatus(agent.skill.name, "online");
      log.success(
        `Agent "${args.name}" 已启动 (PID: ${String(pid)})` +
          `\n  端点: ${agent.transport.type === "streamable-http" ? agent.transport.endpoint : "n/a"}` +
          `\n  日志: ${getAgentLogPath(agentsConfig.dataDir, agent.skill.name)}`,
      );
    } catch (err) {
      if (pid !== undefined) {
        await stopAgentGracefully(agentsConfig.dataDir, agent.skill.name).catch(() => {});
      }
      store.updateStatus(agent.skill.name, "error");
      log.error(`Agent "${args.name}" 启动失败：${err instanceof Error ? err.message : String(err)}`);
      log.info(`日志: ${getAgentLogPath(agentsConfig.dataDir, agent.skill.name)}`);
      process.exitCode = 1;
    }
  },
});
