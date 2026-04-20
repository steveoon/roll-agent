import { defineAgent } from "@roll-agent/sdk";
import { diagnosticStatus } from "./tools/diagnostic-status.ts";
import { generateReply } from "./tools/generate-reply.ts";

const agent = defineAgent({
  name: "smart-reply-agent",
  tools: [generateReply, diagnosticStatus],
});

agent.listen().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
