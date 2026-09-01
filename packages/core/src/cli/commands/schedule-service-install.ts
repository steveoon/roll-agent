import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { auditScheduledServicePlaceholders } from "../../config/placeholder-audit.ts";
import { withSchedulerServiceManagementLock } from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { runScheduleCommand } from "./schedule-command-utils.ts";
import {
  assertNodeSqliteAvailable,
  installSchedulerServiceUnlocked,
} from "./schedule-service-utils.ts";

export function formatInstallEnvPreflight(report: {
  readonly unresolved: ReadonlyArray<{ readonly name: string; readonly paths: readonly string[] }>;
}): string | undefined {
  if (report.unresolved.length === 0) return undefined;
  const lines = report.unresolved.map(
    (item) => `  - \${${item.name}}（用于 ${item.paths.join(", ")}）`,
  );
  return [
    "⚠ 以下配置占位符在调度服务（launchd/schtasks）环境下无法解析（它们不会加载你的 .zshrc）：",
    ...lines,
    "建议将对应值写入 ~/.roll-agent/secrets.env（chmod 600，每行 KEY=VALUE），或使用 --skip-env-check 跳过本检查。",
  ].join("\n");
}

export default defineCommand({
  meta: {
    description: "安装并启动定时任务 daemon 的 per-user LaunchAgent 或当前用户 Scheduled Task",
  },
  args: {
    "skip-env-check": {
      type: "boolean",
      default: false,
      description: "跳过配置占位符环境预检",
    },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      await assertNodeSqliteAvailable();
      const { config } = loadConfig();
      if (args["skip-env-check"] !== true) {
        warnUnresolvedConfigPlaceholders();
      }
      const refreshed = await withSchedulerServiceManagementLock(() =>
        installSchedulerServiceUnlocked(config),
      );
      log.success(
        refreshed
          ? "roll schedule daemon 用户服务定义已刷新（正在运行的 daemon 不会重启）。"
          : "roll schedule daemon 用户服务已安装并启动。",
      );
    });
  },
});

function warnUnresolvedConfigPlaceholders(): void {
  // 配置不可用时由 loadConfig / doctor 负责，这里不阻断安装。
  const audit = auditScheduledServicePlaceholders();
  if (audit === undefined) {
    return;
  }
  const warning = formatInstallEnvPreflight(audit);
  if (warning !== undefined) {
    log.warn(warning);
  }
}
