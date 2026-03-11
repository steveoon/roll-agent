import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "roll",
    version: "0.0.1",
    description: "花卷 Agent — 轻量级 Agent 编排系统",
  },
  subCommands: {
    agent: () => import("./commands/agent.ts").then((m) => m.default),
    run: () => import("./commands/run.ts").then((m) => m.default),
    ask: () => import("./commands/ask.ts").then((m) => m.default),
    config: () => import("./commands/config.ts").then((m) => m.default),
    doctor: () => import("./commands/doctor.ts").then((m) => m.default),
  },
});

runMain(main);
