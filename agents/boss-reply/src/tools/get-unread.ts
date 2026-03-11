import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";

export const getUnread = defineTool({
  name: "get_unread",
  description: "获取 BOSS 直聘未读消息列表",
  input: z.object({
    limit: z.number().optional(),
  }),
  output: z.object({
    messages: z.array(
      z.object({
        id: z.string(),
        candidateName: z.string(),
        content: z.string(),
      }),
    ),
  }),
  execute: async (input, _ctx) => {
    // TODO: implement actual BOSS API integration
    console.log(`Fetching unread messages with limit: ${String(input.limit ?? "all")}`);
    return { messages: [] };
  },
});
