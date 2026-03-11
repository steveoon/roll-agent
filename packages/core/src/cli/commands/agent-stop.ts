import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "停止一个 Agent" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  run({ args }) {
    console.log(`TODO: agent stop ${args.name}`);
  },
});
