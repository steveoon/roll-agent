import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadCompanionCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((module) => module.default);
}

export default defineCommand({
  meta: { description: "管理连接官方 Cloud Relay 的本机 Roll Companion 服务" },
  subCommands: {
    enroll: () => loadCompanionCommand("companion-enroll"),
    unenroll: () => loadCompanionCommand("companion-unenroll"),
    enable: () => loadCompanionCommand("companion-enable"),
    disable: () => loadCompanionCommand("companion-disable"),
    workspace: () => loadCompanionCommand("companion-workspace"),
    service: () => loadCompanionCommand("companion-service"),
    start: () => loadCompanionCommand("companion-start"),
    stop: () => loadCompanionCommand("companion-stop"),
    restart: () => loadCompanionCommand("companion-restart"),
    status: () => loadCompanionCommand("companion-status"),
    run: () => loadCompanionCommand("companion-run"),
    doctor: () => loadCompanionCommand("companion-doctor"),
    logs: () => loadCompanionCommand("companion-logs"),
  },
});
