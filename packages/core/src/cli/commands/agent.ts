import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadAgentCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((m) => m.default);
}

export default defineCommand({
  meta: { description: "管理 Agent（支持本地目录、已安装产物、远程服务）" },
  subCommands: {
    add: () => loadAgentCommand("agent-add"),
    install: () => loadAgentCommand("agent-install"),
    remove: () => loadAgentCommand("agent-remove"),
    list: () => loadAgentCommand("agent-list"),
    tools: () => loadAgentCommand("agent-tools"),
    start: () => loadAgentCommand("agent-start"),
    stop: () => loadAgentCommand("agent-stop"),
    info: () => loadAgentCommand("agent-info"),
    health: () => loadAgentCommand("agent-health"),
  },
});
