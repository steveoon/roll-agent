import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadRuntimeCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((module) => module.default);
}

export default defineCommand({
  meta: { description: "启动和管理供第三方客户端使用的 Roll Runtime" },
  subCommands: {
    serve: () => loadRuntimeCommand("runtime-serve"),
  },
});
