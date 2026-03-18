import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { parseMessageList } from "../pages/zhipin/message-list.ts";

const ReadMessagesInputSchema = z.object({
  limit: z.number().optional().describe("最多返回的消息条数"),
});

const MessageItemSchema = z.object({
  conversationId: z.string(),
  candidateName: z.string(),
  lastMessage: z.string(),
  unreadCount: z.number(),
  timestamp: z.string(),
});

const ReadMessagesOutputSchema = z.object({
  messages: z.array(MessageItemSchema),
  total: z.number(),
});

export const zhipinReadMessages = defineTool({
  name: "zhipin_read_messages",
  description: "读取 BOSS直聘未读消息列表",
  input: ReadMessagesInputSchema,
  output: ReadMessagesOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Reading zhipin messages (limit: ${input.limit ?? "all"})`);

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");

    const messages = await parseMessageList(page, input.limit);

    ctx.logger.info(`Found ${messages.length} messages`);
    return {
      messages: messages.map((m) => ({ ...m })),
      total: messages.length,
    };
  },
});
