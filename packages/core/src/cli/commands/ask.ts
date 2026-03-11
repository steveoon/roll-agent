import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "LLM 智能路由，自动选择 Agent 和 tool" },
  args: {
    message: { type: "positional", description: "自然语言消息", required: true },
  },
  run({ args }) {
    console.log(`TODO: ask "${args.message}"`);
  },
});
