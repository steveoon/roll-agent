import { defineAgent } from "@roll-agent/sdk";
import { getUnread } from "./tools/get-unread.ts";
import { replyCandidate } from "./tools/reply-candidate.ts";
import { batchReply } from "./tools/batch-reply.ts";

const agent = defineAgent({
  name: "boss-reply-agent",
  tools: [getUnread, replyCandidate, batchReply],
});

console.log(`Agent "${agent.name}" loaded with ${agent.tools.length} tools`);
