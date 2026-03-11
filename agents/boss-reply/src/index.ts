import { defineAgent } from "@roll-agent/sdk";
import { getUnread } from "./tools/get-unread.ts";
import { replyCandidate } from "./tools/reply-candidate.ts";
import { batchReply } from "./tools/batch-reply.ts";

const agent = defineAgent({
  name: "boss-reply-agent",
  tools: [getUnread, replyCandidate, batchReply],
});

// 启动 MCP Server (stdio 模式)
agent.listen().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
