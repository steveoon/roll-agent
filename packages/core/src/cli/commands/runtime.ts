import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadRuntimeCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((module) => module.default);
}

export default defineCommand({
  meta: { description: "管理本地 Roll Runtime 与会话库" },
  subCommands: {
    serve: () => loadRuntimeCommand("runtime-serve"),
    migrate: () => loadRuntimeCommand("runtime-migrate"),
  },
});
