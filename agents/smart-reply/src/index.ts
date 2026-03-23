import { defineAgent } from "@roll-agent/sdk";
import { generateReply } from "./tools/generate-reply.ts";
import { syncBrandData } from "./tools/sync-brand-data.ts";

const agent = defineAgent({
  name: "smart-reply-agent",
  tools: [generateReply, syncBrandData],
});

agent.listen().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
