import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "注册一个 Agent" },
  args: {
    path: { type: "positional", description: "Agent 路径或 URL", required: true },
  },
  run({ args }) {
    console.log(`TODO: agent add ${args.path}`);
  },
});
