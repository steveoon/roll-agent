import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";

export const batchReply = defineTool({
  name: "batch_reply",
  description: "批量回复所有未读消息",
  input: z.object({
    dryRun: z.boolean().optional(),
  }),
  output: z.object({
    total: z.number(),
    succeeded: z.number(),
    failed: z.number(),
  }),
  execute: async (input, _ctx) => {
    // TODO: implement batch reply logic
    console.log(`Batch reply (dryRun: ${String(input.dryRun ?? false)})`);
    return { total: 0, succeeded: 0, failed: 0 };
  },
});
