import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadSkillsCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((m) => m.default);
}

export default defineCommand({
  meta: {
    description:
      "读取已注册 Agent 的 SKILL.md（list/get/path），或安装 skill 到 orchestrator 目录（install）",
  },
  subCommands: {
    list: () => loadSkillsCommand("skills-list"),
    get: () => loadSkillsCommand("skills-get"),
    path: () => loadSkillsCommand("skills-path"),
    install: () => loadSkillsCommand("skills-install"),
  },
});
