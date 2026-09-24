import { describeEnvironmentDiagnostics } from "../../config/environment-diagnostics.ts";
import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "查看本机 Companion、Runtime 和 enrollment 状态" },
  args: {
    json: { type: "boolean", description: "以 JSON 输出到 stdout", default: false },
  },
  async run({ args }) {
    await runCompanionCommand(async () => {
      const status = await createCompanionCliApplication().getStatus();
      if (args.json === true) {
        console.log(JSON.stringify(status));
        return;
      }
      log.info(`状态: ${status.phase}`);
      log.info(`设备绑定: ${status.enrolled ? "是" : "否"}`);
      log.info(`启用: ${status.enabled ? "是" : "否"}`);
      log.info(`Runtime: ${status.runtimeOnline ? "在线" : "离线"}`);
      if (status.lastError !== undefined) log.error(status.lastError);
      if (status.environmentDiagnostics !== undefined) {
        const report = status.environmentDiagnostics;
        log.info(
          report.environment === "service"
            ? "配置检查：后台进程实际环境"
            : "配置检查：后台环境估算，未验证实际服务环境",
        );
        if (report.issues.length > 0) log.warn(describeEnvironmentDiagnostics(report));
      }
      if (status.cwd !== undefined) {
        log.info(`Workspace: ${status.cwd}`);
      }
    });
  },
});
