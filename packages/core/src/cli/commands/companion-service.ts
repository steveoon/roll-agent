import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadServiceCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((module) => module.default);
}

export default defineCommand({
  meta: { description: "安装或卸载当前用户的 Companion 登录服务" },
  subCommands: {
    install: () => loadServiceCommand("companion-service-install"),
    uninstall: () => loadServiceCommand("companion-service-uninstall"),
  },
});
