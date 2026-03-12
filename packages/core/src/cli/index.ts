import { defineCommand, runMain } from "citty";
import chalk from "chalk";
import { checkForUpdate, getCurrentVersion } from "./utils/update-checker.ts";

const CLI_VERSION = getCurrentVersion();

const main = defineCommand({
  meta: {
    name: "roll",
    version: CLI_VERSION,
    description: "花卷 Agent — 轻量级 Agent 编排系统",
  },
  subCommands: {
    agent: () => import("./commands/agent.ts").then((m) => m.default),
    run: () => import("./commands/run.ts").then((m) => m.default),
    ask: () => import("./commands/ask.ts").then((m) => m.default),
    config: () => import("./commands/config.ts").then((m) => m.default),
    doctor: () => import("./commands/doctor.ts").then((m) => m.default),
    update: () => import("./commands/update.ts").then((m) => m.default),
  },
});

// 启动提示只读缓存，保证不阻塞 CLI 退出。
const updateCheckPromise = checkForUpdate({ allowNetwork: false }).catch(
  () => undefined,
);

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
