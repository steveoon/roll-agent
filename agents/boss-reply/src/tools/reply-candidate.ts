import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";

export const replyCandidate = defineTool({
  name: "reply_candidate",
  description: "回复指定候选人",
  input: z.object({
    candidateId: z.string(),
    message: z.string().optional(),
  }),
  output: z.object({
    success: z.boolean(),
    repliedMessage: z.string(),
  }),
  execute: async (input, _ctx) => {
    // TODO: implement actual reply logic
    console.log(`Replying to candidate: ${input.candidateId}`);
    return { success: true, repliedMessage: "TODO: generated reply" };
  },
});
