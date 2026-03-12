import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadAgentCommand(fileName: string) {
  const specifier = new URL(
    `./${fileName}.${commandExtension}`,
    import.meta.url,
  ).href;
  return import(specifier).then((m) => m.default);
}

export default defineCommand({
  meta: { description: "管理 Agent（stdio 按需生命周期）" },
  subCommands: {
    add: () => loadAgentCommand("agent-add"),
    remove: () => loadAgentCommand("agent-remove"),
    list: () => loadAgentCommand("agent-list"),
    start: () => loadAgentCommand("agent-start"),
    stop: () => loadAgentCommand("agent-stop"),
    info: () => loadAgentCommand("agent-info"),
    health: () => loadAgentCommand("agent-health"),
  },
});
