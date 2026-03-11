import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "启动一个 Agent" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  run({ args }) {
    console.log(`TODO: agent start ${args.name}`);
  },
});
