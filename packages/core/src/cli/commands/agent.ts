import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "管理 Agent（add/remove/list/start/stop/info/health）" },
  subCommands: {
    add: () => import("./agent-add.ts").then((m) => m.default),
    remove: () => import("./agent-remove.ts").then((m) => m.default),
    list: () => import("./agent-list.ts").then((m) => m.default),
    start: () => import("./agent-start.ts").then((m) => m.default),
    stop: () => import("./agent-stop.ts").then((m) => m.default),
    info: () => import("./agent-info.ts").then((m) => m.default),
    health: () => import("./agent-health.ts").then((m) => m.default),
  },
});
