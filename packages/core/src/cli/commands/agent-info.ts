import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "查看 Agent 详情" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  run({ args }) {
    console.log(`TODO: agent info ${args.name}`);
  },
});
