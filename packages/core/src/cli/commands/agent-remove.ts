import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "移除一个 Agent" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  run({ args }) {
    console.log(`TODO: agent remove ${args.name}`);
  },
});
