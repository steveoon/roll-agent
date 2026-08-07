import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

export default defineCommand({
  meta: { description: "管理唯一的本机 Companion Workspace" },
  subCommands: {
    set: () =>
      import(new URL(`./companion-workspace-set.${commandExtension}`, import.meta.url).href).then(
        (module) => module.default,
      ),
  },
});
