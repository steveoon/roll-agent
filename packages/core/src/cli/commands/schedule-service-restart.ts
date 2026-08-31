import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  SCHEDULER_SERVICE_RESTART_ACTIONS,
  planSchedulerServiceRestart,
} from "../../scheduler-host/service-plan.ts";
import {
  inspectSchedulerServiceState,
  schedulerServiceStatePath,
} from "../../scheduler-host/service-state.ts";
import { withSchedulerServiceManagementLock } from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { printJson, runScheduleCommand } from "./schedule-command-utils.ts";
import {
  assertNodeSqliteAvailable,
  describeSchedulerServiceRestartRefusal,
  restartInstalledSchedulerServiceUnlocked,
  restartSchedulerServiceUnlocked,
  type RestartSchedulerServiceResult,
} from "./schedule-service-utils.ts";

export default defineCommand({
  meta: {
    description:
      "重启定时任务 daemon 的用户服务：卸载后按当前 roll 与配置重装（升级 roll / 切换 Node 后使用；有任务运行时拒绝）",
  },
  args: {
    force: {
      type: "boolean",
      description: "即使有 live invocation 也重启（中断 daemon-owned；run-now --inline 不受影响）",
      default: false,
    },
    "installed-settings": {
      type: "boolean",
      description:
        "沿用已安装 metadata 里的 data-dir / max-concurrent-runs，不读取当前配置（roll update 自动重启使用）",
      default: false,
    },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      await assertNodeSqliteAvailable();
      const notInstalled = planSchedulerServiceRestart({
        inspection: inspectSchedulerServiceState(schedulerServiceStatePath()),
        liveInvocations: 0,
        force: args.force,
      });
      const restart = async (): Promise<RestartSchedulerServiceResult> => {
        if (notInstalled === SCHEDULER_SERVICE_RESTART_ACTIONS.notInstalled) {
          return { action: notInstalled, liveInvocations: 0 };
        }
        if (args["installed-settings"]) {
          return restartInstalledSchedulerServiceUnlocked({ force: args.force });
        }
        const { config } = loadConfig();
        return restartSchedulerServiceUnlocked({ config, force: args.force });
      };
      const result = await withSchedulerServiceManagementLock(restart);
      if (args.json) {
        const restarted = result.action === SCHEDULER_SERVICE_RESTART_ACTIONS.restart;
        printJson({
          ...result,
          ...(restarted ? {} : { reason: describeSchedulerServiceRestartRefusal(result) }),
        });
        if (!restarted) {
          process.exitCode = 1;
        }
        return;
      }
      if (result.action !== SCHEDULER_SERVICE_RESTART_ACTIONS.restart) {
        throw new Error(describeSchedulerServiceRestartRefusal(result));
      }
      log.success(
        `roll schedule daemon 用户服务已重启${result.liveInvocations > 0 ? `（重启前检测到 ${String(result.liveInvocations)} 个 live invocation；daemon-owned 已中断，run-now --inline 不受影响）` : ""}。`,
      );
    });
  },
});
