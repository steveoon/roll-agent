import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadScheduleServiceCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((m) => m.default);
}

export default defineCommand({
  meta: { description: "把定时任务 daemon 安装为用户级常驻服务（LaunchAgent / Scheduled Task）" },
  subCommands: {
    install: () => loadScheduleServiceCommand("schedule-service-install"),
    uninstall: () => loadScheduleServiceCommand("schedule-service-uninstall"),
    status: () => loadScheduleServiceCommand("schedule-service-status"),
  },
});
