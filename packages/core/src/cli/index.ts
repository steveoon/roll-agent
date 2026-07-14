import { defineCommand, runMain } from "citty";
import chalk from "chalk";
import { checkForUpdate, getCurrentVersion } from "./utils/update-checker.ts";
import { resolveLogLevelFromArgv, setLogLevel } from "./utils/output.ts";

const CLI_VERSION = getCurrentVersion();
const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadMainCommand(commandName: string) {
  const specifier = new URL(`./commands/${commandName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((m) => m.default);
}

const main = defineCommand({
  meta: {
    name: "roll",
    version: CLI_VERSION,
    description: "花卷 Agent — 轻量级 Agent 编排系统",
  },
  args: {
    verbose: {
      type: "boolean",
      alias: "v",
      description: "输出调试日志",
      default: false,
    },
  },
  subCommands: {
    agent: () => loadMainCommand("agent"),
    run: () => loadMainCommand("run"),
    ask: () => loadMainCommand("ask"),
    chat: () => loadMainCommand("chat"),
    config: () => loadMainCommand("config"),
    setup: () => loadMainCommand("setup"),
    skills: () => loadMainCommand("skills"),
    browser: () => loadMainCommand("browser"),
    ui: () => loadMainCommand("ui"),
    doctor: () => loadMainCommand("doctor"),
    update: () => loadMainCommand("update"),
  },
});

// 启动提示只读缓存，保证不阻塞 CLI 退出。
const updateCheckPromise = checkForUpdate({ allowNetwork: false }).catch(() => undefined);

setLogLevel(resolveLogLevelFromArgv(process.argv.slice(2)));

runMain(main).then(() => {
  updateCheckPromise
    .then((info) => {
      if (info?.hasUpdate) {
        console.error(
          `\n${chalk.yellow("⬆")} roll ${chalk.green(`v${info.latest}`)} available (current: v${info.current}). Run ${chalk.cyan("roll update")} to upgrade.`,
        );
      }
    })
    .catch(() => undefined);
});
