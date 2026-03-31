import { defineAgent } from "@roll-agent/sdk";
import { sendFeishuMessage } from "./tools/send-feishu-message.ts";

const agent = defineAgent({
  name: "notify-agent",
  tools: [sendFeishuMessage],
});

agent.listen().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
