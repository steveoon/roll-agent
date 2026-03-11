import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "声明式调用 Agent 的指定 tool" },
  args: {
    agent: { type: "positional", description: "Agent 名称", required: true },
    tool: { type: "positional", description: "Tool 名称", required: true },
  },
  run({ args }) {
    console.log(`TODO: run ${args.agent} ${args.tool}`);
  },
});
