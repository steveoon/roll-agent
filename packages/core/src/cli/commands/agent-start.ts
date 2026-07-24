import { defineCommand } from "citty";
import { getAgentEnv } from "../../config/helpers.ts";
import { loadAgentsConfig, loadConfig } from "../../config/loader.ts";
import {
  getAgentLogPath,
  probeAgentEndpoint,
  waitForAgentReady,
} from "../../registry/process-manager.ts";
import { acquireAgentRegistryLockAsync } from "../../registry/agent-registry-lock.ts";
import {
  finalizeAgentStartForCommand,
  prepareAgentStartForCommand,
  type AgentStartAttempt,
} from "../../registry/managed-agent-start.ts";
import { AgentStore } from "../../registry/store.ts";
import { log } from "../utils/output.ts";

export default defineCommand({
  meta: { description: "启动由 Roll 托管的 core-managed Agent" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    let attempt: AgentStartAttempt | undefined;
    let preparationFailed = false;
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

      const preparation = await prepareAgentStartForCommand(
        agent,
        store,
        agentsConfig.dataDir,
        () => getAgentEnv(loadConfig().config, agent.skill.name),
      );
      if (preparation.ok) {
        attempt = preparation.attempt;
      } else {
        preparationFailed = true;
        const err = preparation.error;
        log.error(
          `Agent "${args.name}" 启动失败：${err instanceof Error ? err.message : String(err)}`,
        );
        log.info(`日志: ${getAgentLogPath(agentsConfig.dataDir, agent.skill.name)}`);
        process.exitCode = 1;
      }
    } finally {
      registryLock.release();
    }

    if (preparationFailed || attempt === undefined) return;

    let readinessError: unknown;
    try {
      if (attempt.started) {
        await waitForAgentReady(attempt.agent, {
          startupTimeoutMs: 15_000,
          probeTimeoutMs: 2_000,
        });
      } else {
        await probeAgentEndpoint(attempt.agent, { timeoutMs: 3_000 });
      }
    } catch (error) {
      readinessError = error;
    }

    const { finalization, finalizationError, fallbackCleanup, fallbackCleanupError } =
      await finalizeAgentStartForCommand(
        attempt,
        agentsConfig.dataDir,
        readinessError === undefined ? "online" : "error",
      );
    const statusCommitted = finalization?.kind === "committed" || finalization?.kind === "in-use";

    if (readinessError !== undefined) {
      log.error(
        `Agent "${args.name}" 启动失败：${
          readinessError instanceof Error ? readinessError.message : String(readinessError)
        }`,
      );
      if (finalization?.kind === "in-use") {
        log.info("启动探活失败，但 Agent 正被其他 Roll 使用，因此未停止。");
      }
      if (!statusCommitted) {
        log.info(
          finalizationError === undefined
            ? "启动等待期间 Agent 注册项或 runtime 已变化，未覆盖当前状态。"
            : "启动失败状态未能写回 Agent 注册表。",
        );
      }
      if (fallbackCleanup?.kind === "stopped") {
        log.info("状态收尾获取注册表锁失败；已按 runtime identity 安全回收新进程。");
      } else if (fallbackCleanup?.kind === "in-use") {
        log.info("状态收尾获取注册表锁失败；Agent 正被其他 Roll 使用，因此未停止。");
      } else if (fallbackCleanup?.kind === "stale") {
        log.info("状态收尾获取注册表锁失败；runtime 已变化，因此未停止。");
      }
      if (finalizationError !== undefined) {
        log.error(
          `启动失败后的状态收尾也失败：${
            finalizationError instanceof Error
              ? finalizationError.message
              : String(finalizationError)
          }`,
        );
      }
      if (fallbackCleanupError !== undefined) {
        log.error(
          `启动失败后的安全回收也失败：${
            fallbackCleanupError instanceof Error
              ? fallbackCleanupError.message
              : String(fallbackCleanupError)
          }`,
        );
      }
      log.info(`日志: ${getAgentLogPath(agentsConfig.dataDir, attempt.agent.skill.name)}`);
      process.exitCode = 1;
      return;
    }

    if (!statusCommitted) {
      log.error(
        `Agent "${args.name}" 启动完成前注册项或 runtime 已被其他操作改变，未覆盖当前状态。`,
      );
      if (finalizationError !== undefined) {
        log.error(
          finalizationError instanceof Error
            ? finalizationError.message
            : String(finalizationError),
        );
      }
      process.exitCode = 1;
      return;
    }

    log.success(
      `Agent "${args.name}" ${attempt.started ? "已启动" : "已在运行并保持常驻"} ` +
        `(PID: ${String(attempt.runtimeIdentity.pid)})` +
        `\n  端点: ${
          attempt.agent.transport.type === "streamable-http"
            ? attempt.agent.transport.endpoint
            : "n/a"
        }` +
        `\n  日志: ${getAgentLogPath(agentsConfig.dataDir, attempt.agent.skill.name)}`,
    );
  },
});
