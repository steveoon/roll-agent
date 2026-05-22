import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadBrowserCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((m) => m.default);
}

export default defineCommand({
  meta: { description: "管理浏览器运行时数据" },
  subCommands: {
    "clear-data": () => loadBrowserCommand("browser-clear-data"),
    stop: () => loadBrowserCommand("browser-stop"),
  },
});
