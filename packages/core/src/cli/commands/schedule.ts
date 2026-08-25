import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadScheduleCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((m) => m.default);
}

export default defineCommand({
  meta: { description: "管理定时任务：按周期无人值守地运行一轮 chat" },
  subCommands: {
    add: () => loadScheduleCommand("schedule-add"),
    list: () => loadScheduleCommand("schedule-list"),
    show: () => loadScheduleCommand("schedule-show"),
    remove: () => loadScheduleCommand("schedule-remove"),
    pause: () => loadScheduleCommand("schedule-pause"),
    resume: () => loadScheduleCommand("schedule-resume"),
    runs: () => loadScheduleCommand("schedule-runs"),
    exec: () => loadScheduleCommand("schedule-exec"),
  },
});
