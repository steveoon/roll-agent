import { defineCommand } from "citty";
import { isCancel, note, select } from "@clack/prompts";
import stringWidth from "string-width";
import { loadAgentsConfig } from "../../config/loader.ts";
import {
  AGENT_USAGE_STOP_RECOVERY_STATUSES,
  acquireAgentUsageMaintenanceGuard,
  inspectAgentUsageStopRecovery,
  recoverInterruptedAgentStop,
  type AgentUsageHolderKind,
  type AgentUsageStopRecoveryInspection,
} from "../../registry/agent-usage-lease.ts";
import { acquireAgentRegistryLockAsync } from "../../registry/agent-registry-lock.ts";
import { stopAgentGracefully } from "../../registry/process-manager.ts";
import { AgentStore } from "../../registry/store.ts";
import { log } from "../utils/output.ts";

type RecoverableAgentStopInspection = Extract<
  AgentUsageStopRecoveryInspection,
  { readonly status: typeof AGENT_USAGE_STOP_RECOVERY_STATUSES.RECOVERABLE }
>;

const RECOVERY_ROW_VALUE_COLUMN = 10;
const AGENT_USAGE_HOLDER_LABELS = {
  chat: "roll chat",
  run: "roll run",
  ask: "roll ask",
  "agent-tools": "roll agent tools",
  "browser-stop": "roll browser stop",
  diagnostics: "运行时诊断",
} as const satisfies Record<AgentUsageHolderKind, string>;

export default defineCommand({
  meta: { description: "停止由 Roll 托管的 core-managed Agent" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
    recover: {
      type: "boolean",
      description: "非交互环境下确认清理可验证的残留状态；不会跳过安全检查",
      default: false,
    },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const initialAgent = new AgentStore(agentsConfig.dataDir).findByName(args.name);
    if (!initialAgent) {
      log.error(`Agent "${args.name}" 未找到`);
      process.exitCode = 1;
      return;
    }

    switch (initialAgent.runtime.ownership) {
      case "on-demand":
        log.success(`Agent "${args.name}" 为按需模式，无需手动停止。`);
        return;
      case "external-managed":
        log.info(`Agent "${args.name}" 由外部服务管理，请在外部停止。`);
        if (initialAgent.transport.type === "streamable-http") {
          log.info(`端点: ${initialAgent.transport.endpoint}`);
        }
        return;
      case "core-managed":
        break;
    }

    let recoveryApproved = false;
    try {
      const recoveryInspection = await inspectAgentUsageStopRecovery(
        initialAgent,
        agentsConfig.dataDir,
      );
      if (recoveryInspection.status === AGENT_USAGE_STOP_RECOVERY_STATUSES.RECOVERABLE) {
        note(formatAgentStopRecoveryLines(recoveryInspection).join("\n"), "上次停止未完成", {
          output: process.stderr,
        });
        for (const release of recoveryInspection.releases) {
          log.debug(`残留租约 ${release.leaseId}：${release.filePath}`);
        }
        if (args.recover) {
          recoveryApproved = true;
        } else if (process.stdin.isTTY === true && process.stderr.isTTY === true) {
          recoveryApproved = await confirmAgentStopRecovery(recoveryInspection);
        } else {
          log.error(
            "当前环境无法显示确认菜单。" +
              `若要继续完成停止，请运行 \`roll agent stop ${initialAgent.skill.name} --recover\`；` +
              "执行前仍会重新校验状态。",
          );
          process.exitCode = 1;
          return;
        }
        if (!recoveryApproved) {
          log.info("已取消；残留状态和 Agent 均未修改。");
          return;
        }
      } else if (
        args.recover &&
        recoveryInspection.status === AGENT_USAGE_STOP_RECOVERY_STATUSES.BLOCKED
      ) {
        log.error(`无法安全恢复：${recoveryInspection.reason}`);
        process.exitCode = 1;
        return;
      }
    } catch (error) {
      log.error(
        `检查 Agent "${args.name}" 的中断释放状态失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
      return;
    }

    const registryLock = await acquireAgentRegistryLockAsync(agentsConfig.dataDir);
    try {
      const store = new AgentStore(agentsConfig.dataDir, { registryLock });
      const agent = store.findByName(args.name);
      if (!agent) {
        log.error(`Agent "${args.name}" 未找到`);
        process.exitCode = 1;
        return;
      }
      if (agent.runtime.ownership !== "core-managed") {
        log.error(`Agent "${args.name}" 的运行时所有权已发生变化，请重试。`);
        process.exitCode = 1;
        return;
      }

      let stopped = false;
      let recoveredReleaseCount = 0;
      let maintenanceGuard:
        | Awaited<ReturnType<typeof acquireAgentUsageMaintenanceGuard>>
        | undefined;
      try {
        if (process.platform === "win32") {
          log.info("Windows 下停止为强制终止（无优雅退出信号），Agent 不会执行清理逻辑");
        }
        if (recoveryApproved) {
          const recoveryResult = await recoverInterruptedAgentStop(agent, agentsConfig.dataDir);
          if (recoveryResult !== undefined) {
            stopped = recoveryResult.runtimeStopped;
            recoveredReleaseCount = recoveryResult.recoveredReleaseCount;
          }
        }
        if (recoveredReleaseCount === 0) {
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
        }
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

      if (recoveredReleaseCount > 0) {
        log.success(
          stopped
            ? `Agent "${args.name}" 已清理 ${String(recoveredReleaseCount)} 个残留记录并停止`
            : `Agent "${args.name}" 已清理 ${String(recoveredReleaseCount)} 个残留记录；当前未运行`,
        );
        return;
      }
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

export function formatAgentStopRecoveryLines(
  inspection: RecoverableAgentStopInspection,
): readonly string[] {
  const runtime =
    inspection.runtimePid === null
      ? "当前未运行"
      : `PID ${String(inspection.runtimePid)}（已确认属于该 Agent）`;
  const sourceLines = inspection.releases.map((release, index) =>
    formatRecoveryRow(
      index === 0 ? "中断来源" : "",
      `${AGENT_USAGE_HOLDER_LABELS[release.holderKind]} · PID ${String(release.ownerPid)} 已退出`,
    ),
  );
  const nextStep =
    inspection.runtimePid === null
      ? "继续后会再次校验状态，并清理残留记录。"
      : "继续后会再次校验状态，清理残留记录并停止 Runtime。";
  return [
    formatRecoveryRow("Agent", inspection.agentName),
    formatRecoveryRow("Runtime", runtime),
    formatRecoveryRow("残留记录", `${String(inspection.releases.length)} 个`),
    ...sourceLines,
    formatRecoveryRow("当前状态", "未发现其他 Roll 进程正在使用此 Agent"),
    "",
    nextStep,
  ];
}

async function confirmAgentStopRecovery(
  inspection: RecoverableAgentStopInspection,
): Promise<boolean> {
  const answer = await select({
    message: `是否继续完成 Agent "${inspection.agentName}" 的停止操作？`,
    options: [
      {
        value: "recover",
        label: "继续完成停止",
        hint:
          inspection.runtimePid === null
            ? "重新校验后清理残留状态"
            : `重新校验后清理残留并停止 PID ${String(inspection.runtimePid)}`,
      },
      { value: "cancel", label: "暂不处理", hint: "保留当前状态" },
    ],
    initialValue: "cancel",
    output: process.stderr,
  });
  return !isCancel(answer) && answer === "recover";
}

function formatRecoveryRow(label: string, value: string): string {
  const padding = " ".repeat(Math.max(1, RECOVERY_ROW_VALUE_COLUMN - stringWidth(label)));
  return `${label}${padding}${value}`;
}
